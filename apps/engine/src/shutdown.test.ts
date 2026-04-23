import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(__dirname, "./index.ts");

async function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectPort(new Error("unexpected address shape"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await delay(50);
  }
  throw new Error(`engine never became healthy on port ${port}`);
}

type SpawnedEngine = {
  child: ChildProcess;
  port: number;
  stdout: string[];
  stderr: string[];
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnEngine(port: number): SpawnedEngine {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ENTRY],
    {
      // ENGINE_DISABLE_STAGES isolates these tests to the HTTP +
      // signal-handling surface — bootstrap (Plex client + ffmpeg
      // supervisors) is exercised by bootstrap.test.ts with mocks.
      env: {
        ...process.env,
        ENGINE_PORT: String(port),
        ENGINE_DISABLE_STAGES: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (b: Buffer) => stdout.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()));

  const done = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));

  return { child, port, stdout, stderr, done };
}

/** Pick a free port → spawn the engine → wait for /api/health.
 *
 *  pickFreePort closes its probe socket before spawn() calls listen(),
 *  which leaves a tiny TOCTOU window where another process can grab the
 *  port. On CI under load this races, so retry on any failure of
 *  waitForHealth (which covers EADDRINUSE — engine exits 1 → fetch fails
 *  forever → timeout). We kill and fully drain the loser child before the
 *  next attempt so the test stays deterministic.
 */
async function startEngineOnFreePort(maxAttempts = 5): Promise<SpawnedEngine> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await pickFreePort();
    const engine = spawnEngine(port);
    try {
      await waitForHealth(port);
      return engine;
    } catch (err) {
      lastErr = err;
      if (engine.child.exitCode === null && !engine.child.killed) {
        engine.child.kill("SIGKILL");
      }
      // Drain the exit promise so nothing lingers between attempts.
      await engine.done.catch(() => {});
      await delay(50 * attempt);
    }
  }
  throw new Error(
    `could not start engine on a free port after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

describe("graceful shutdown (integration)", () => {
  it("exits 0 on SIGTERM and logs the shutdown sequence", async () => {
    const engine = await startEngineOnFreePort();

    try {
      const res = await fetch(`http://127.0.0.1:${engine.port}/api/health`);
      assert.equal(res.status, 200);

      engine.child.kill("SIGTERM");
      const { code, signal } = await engine.done;

      assert.equal(code, 0, `expected clean exit; stderr=${engine.stderr.join("")}`);
      assert.equal(signal, null);

      const log = engine.stdout.join("");
      assert.match(log, /received SIGTERM, stopping stages \+ server/);
      assert.match(log, /shutdown complete/);
    } finally {
      if (engine.child.exitCode === null && !engine.child.killed) {
        engine.child.kill("SIGKILL");
      }
    }
  });

  it("exits 0 on SIGINT", async () => {
    const engine = await startEngineOnFreePort();

    try {
      engine.child.kill("SIGINT");
      const { code } = await engine.done;
      assert.equal(code, 0, `stderr=${engine.stderr.join("")}`);
      assert.match(engine.stdout.join(""), /received SIGINT/);
    } finally {
      if (engine.child.exitCode === null && !engine.child.killed) {
        engine.child.kill("SIGKILL");
      }
    }
  });

  it("exits 0 on SIGHUP", async () => {
    const engine = await startEngineOnFreePort();

    try {
      engine.child.kill("SIGHUP");
      const { code } = await engine.done;
      assert.equal(code, 0, `stderr=${engine.stderr.join("")}`);
      assert.match(engine.stdout.join(""), /received SIGHUP/);
    } finally {
      if (engine.child.exitCode === null && !engine.child.killed) {
        engine.child.kill("SIGKILL");
      }
    }
  });

  it("a second SIGTERM while shutting down is idempotent (no crash)", async () => {
    const engine = await startEngineOnFreePort();

    try {
      engine.child.kill("SIGTERM");
      // Fire a second signal immediately; should be ignored by the shuttingDown guard.
      engine.child.kill("SIGTERM");
      const { code } = await engine.done;
      assert.equal(code, 0);
      const log = engine.stdout.join("");
      const matches = log.match(/received SIGTERM, stopping stages \+ server/g) ?? [];
      assert.equal(matches.length, 1, "shutdown() should run exactly once");
    } finally {
      if (engine.child.exitCode === null && !engine.child.killed) {
        engine.child.kill("SIGKILL");
      }
    }
  });

  it("exits 1 immediately when ENGINE_PORT is invalid", async () => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ENTRY],
      {
        env: { ...process.env, ENGINE_PORT: "0x7D9" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderrChunks: string[] = [];
    child.stderr?.on("data", (b: Buffer) => stderrChunks.push(b.toString()));

    const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(code, 1);
    assert.match(stderrChunks.join(""), /ENGINE_PORT must be/);
  });
});
