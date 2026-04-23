import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStageRegistry } from "./registry.ts";
import type { StageController, StageSnapshot } from "./supervisor.ts";

function makeFakeController(
  stageId: string,
  opts: { stopBehavior?: "ok" | "throw" } = {},
): StageController {
  let status: "starting" | "playing" | "stopped" = "starting";
  const snapshot: StageSnapshot = {
    status: "starting",
    track: null,
    trackStartedAt: null,
  };
  return {
    stageId,
    status: () => status,
    currentTrack: () => null,
    snapshot: () => ({ ...snapshot, status }),
    setTracks: () => {},
    stop: async () => {
      if (opts.stopBehavior === "throw") {
        throw new Error("stop intentionally failed");
      }
      status = "stopped";
    },
    done: Promise.resolve(),
  };
}

describe("createStageRegistry", () => {
  it("registers and retrieves a controller by stageId", () => {
    const r = createStageRegistry();
    const c = makeFakeController("opening");
    r.register(c);
    assert.equal(r.size, 1);
    assert.equal(r.get("opening"), c);
  });

  it("returns undefined for an unknown stage", () => {
    const r = createStageRegistry();
    assert.equal(r.get("nope"), undefined);
  });

  it("replaces a controller when registering the same id again", () => {
    const r = createStageRegistry();
    const a = makeFakeController("opening");
    const b = makeFakeController("opening");
    r.register(a);
    r.register(b);
    assert.equal(r.size, 1);
    assert.equal(r.get("opening"), b);
  });

  it("all() returns every registered controller", () => {
    const r = createStageRegistry();
    const a = makeFakeController("opening");
    const b = makeFakeController("closing");
    r.register(a);
    r.register(b);
    const all = r.all();
    assert.equal(all.length, 2);
    assert.ok(all.includes(a));
    assert.ok(all.includes(b));
  });

  it("stopAll() stops every controller", async () => {
    const r = createStageRegistry();
    const a = makeFakeController("opening");
    const b = makeFakeController("closing");
    r.register(a);
    r.register(b);
    await r.stopAll();
    assert.equal(a.status(), "stopped");
    assert.equal(b.status(), "stopped");
  });

  it("stopAll() swallows individual stop errors so others still stop", async () => {
    const r = createStageRegistry();
    const ok = makeFakeController("opening");
    const bad = makeFakeController("broken", { stopBehavior: "throw" });
    r.register(ok);
    r.register(bad);
    // Must not reject — that would leave callers unable to clean up
    // the rest of the registry on a single misbehaving stage.
    await r.stopAll();
    assert.equal(ok.status(), "stopped");
  });

  it("stopAll() on an empty registry resolves immediately", async () => {
    const r = createStageRegistry();
    await r.stopAll();
    assert.equal(r.size, 0);
  });
});
