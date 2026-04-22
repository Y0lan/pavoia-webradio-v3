import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlexClient, PlexApiError, type PlexSkipReason } from "./client.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Spin up a real HTTP server so we test the actual fetch → response path,
    not a fetch mock. Per-test handler is swapped via `setHandler(fn)`. */
class StubPlex {
  private server: Server;
  private handler: Handler = (_req, res) => {
    res.statusCode = 500;
    res.end();
  };
  port = 0;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];

  constructor() {
    this.server = http.createServer(async (req, res) => {
      this.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
      });
      try {
        await this.handler(req, res);
      } catch (err) {
        if (!res.headersSent) res.statusCode = 500;
        res.end(`handler threw: ${(err as Error).message}`);
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;
  }

  setHandler(h: Handler): void {
    this.handler = h;
    this.requests = [];
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const LIB_ROOT = "/home/yolan/files/plex_music_library/opus";

function entry(partial: {
  ratingKey?: string;
  type?: string;
  title?: string;
  grandparentTitle?: string | null;
  parentTitle?: string | null;
  parentYear?: number | null;
  duration?: number | null;
  thumb?: string | null;
  file?: string;
}): Record<string, unknown> {
  return {
    ratingKey: partial.ratingKey ?? "1",
    type: partial.type ?? "track",
    title: partial.title ?? "T",
    grandparentTitle: partial.grandparentTitle ?? "A",
    parentTitle: partial.parentTitle ?? "B",
    parentYear: partial.parentYear ?? 2020,
    duration: partial.duration ?? 100_000,
    thumb: partial.thumb ?? "/library/metadata/1/thumb/1",
    Media: [{ Part: [{ file: partial.file ?? `${LIB_ROOT}/song.mp3` }] }],
  };
}

function plexPlaylistFixture(overrides?: { metadata?: unknown[]; totalSize?: number }): unknown {
  const metadata = overrides?.metadata ?? [
    {
      ratingKey: "12345",
      type: "track",
      title: "Opening Set",
      grandparentTitle: "DJ Curator",
      parentTitle: "Compilation Vol. 1",
      parentYear: 2023,
      duration: 312_000,
      thumb: "/library/metadata/12345/thumb/1",
      Media: [
        { Part: [{ file: `${LIB_ROOT}/artist/album/01 - Opening Set.mp3`, size: 10_000_000 }] },
      ],
    },
    {
      ratingKey: "67890",
      type: "track",
      title: "Après-minuit",
      grandparentTitle: "Café Noir",
      parentTitle: "Nuit blanche",
      parentYear: 2024,
      duration: 245_000,
      thumb: "/library/metadata/67890/thumb/1",
      Media: [
        { Part: [{ file: `${LIB_ROOT}/Café Noir/Nuit blanche/02 - Après-minuit.mp3` }] },
      ],
    },
  ];
  return {
    MediaContainer: {
      size: metadata.length,
      totalSize: overrides?.totalSize ?? metadata.length,
      Metadata: metadata,
    },
  };
}

describe("PlexClient.fetchPlaylist", () => {
  const stub = new StubPlex();

  before(async () => {
    await stub.start();
  });

  after(async () => {
    await stub.stop();
  });

  it("happy path: parses a 2-track playlist into Track[] with correct mapping", async () => {
    stub.setHandler((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(plexPlaylistFixture()));
    });

    const client = createPlexClient({
      baseUrl: stub.url,
      token: "test-token",
      libraryRoot: LIB_ROOT,
    });

    const result = await client.fetchPlaylist(145472);
    assert.equal(result.ratingKey, 145472);
    assert.equal(result.tracks.length, 2);
    assert.equal(result.skipped, 0);

    const [t1, t2] = result.tracks;
    assert.equal(t1!.plexRatingKey, 12345);
    assert.equal(t1!.title, "Opening Set");
    assert.equal(t1!.artist, "DJ Curator");
    assert.equal(t1!.album, "Compilation Vol. 1");
    assert.equal(t1!.albumYear, 2023);
    assert.equal(t1!.durationSec, 312);
    assert.equal(t1!.filePath, `${LIB_ROOT}/artist/album/01 - Opening Set.mp3`);
    assert.equal(t1!.coverUrl, "/library/metadata/12345/thumb/1");
    assert.match(t1!.fallbackHash, /^[0-9a-f]{16}$/);

    assert.equal(t2!.title, "Après-minuit");
    assert.equal(t2!.artist, "Café Noir");
  });

  it("sends the Plex token as X-Plex-Token header, not in the query string", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify(plexPlaylistFixture({ metadata: [] })));
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "secret-token-xyz",
      libraryRoot: LIB_ROOT,
    });
    await client.fetchPlaylist(1);
    const req = stub.requests.at(-1)!;
    assert.equal(req.headers["x-plex-token"], "secret-token-xyz");
    assert.equal(req.headers["accept"], "application/json");
    assert.equal(
      req.url?.toLowerCase().includes("token"),
      false,
      "token must not be in URL (case-insensitive)",
    );
    assert.equal(req.url?.includes("secret"), false);
  });

  it("requests `/playlists/:id/items` with X-Plex-Container-Start and Size", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify(plexPlaylistFixture({ metadata: [] })));
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
    });
    await client.fetchPlaylist(42);
    const url = stub.requests.at(-1)!.url!;
    assert.ok(url.startsWith("/playlists/42/items?"), `got ${url}`);
    assert.match(url, /X-Plex-Container-Start=0/);
    assert.match(url, /X-Plex-Container-Size=\d+/);
  });

  it("tolerates trailing slashes on baseUrl", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify(plexPlaylistFixture({ metadata: [] })));
    });
    const client = createPlexClient({
      baseUrl: `${stub.url}//`,
      token: "t",
      libraryRoot: LIB_ROOT,
    });
    await client.fetchPlaylist(7);
    assert.ok(stub.requests.at(-1)!.url!.startsWith("/playlists/7/items?"));
  });

  it("empty playlist (size=0, no Metadata): returns tracks=[], skipped=0", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify({ MediaContainer: { size: 0, totalSize: 0 } }));
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(99);
    assert.deepEqual(result.tracks, []);
    assert.equal(result.skipped, 0);
  });

  it("401 → PlexApiError{kind:'auth'}", async () => {
    stub.setHandler((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":"unauthorized"}');
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "bad", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "auth",
    );
  });

  it("403 is treated as auth as well", async () => {
    stub.setHandler((_req, res) => {
      res.statusCode = 403;
      res.end("");
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "bad", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "auth",
    );
  });

  it("404 → PlexApiError{kind:'not_found', ratingKey}", async () => {
    stub.setHandler((_req, res) => {
      res.statusCode = 404;
      res.end("");
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(12345),
      (err: unknown) =>
        err instanceof PlexApiError &&
        err.detail.kind === "not_found" &&
        err.detail.ratingKey === 12345,
    );
  });

  it("500 → PlexApiError{kind:'server', status}", async () => {
    stub.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end("plex overloaded");
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) =>
        err instanceof PlexApiError &&
        err.detail.kind === "server" &&
        err.detail.status === 503,
    );
  });

  it("non-JSON body → invalid_response", async () => {
    stub.setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("<html>Plex UI</html>");
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "invalid_response",
    );
  });

  it("JSON that doesn't match the schema → invalid_response with issue list", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify({ not: "a plex response" }));
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => {
        if (!(err instanceof PlexApiError)) return false;
        if (err.detail.kind !== "invalid_response") return false;
        assert.ok(err.detail.issues.length > 0, "should list schema issues");
        return true;
      },
    );
  });

  it("inconsistent container: size>0 but Metadata:[] → invalid_response", async () => {
    stub.setHandler((_req, res) => {
      res.end(JSON.stringify({ MediaContainer: { size: 5, totalSize: 5, Metadata: [] } }));
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "invalid_response",
    );
  });

  it("inconsistent container: size !== Metadata.length (any mismatch) → invalid_response", async () => {
    // Covers the subtle case where Plex returns some items but reports a
    // different size — advancing pagination by `size` would skip or
    // re-read items. Must reject, not paper over.
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify({
          MediaContainer: {
            size: 5,
            totalSize: 5,
            Metadata: [
              entry({ ratingKey: "1" }),
              entry({ ratingKey: "2" }),
              entry({ ratingKey: "3" }),
            ],
          },
        }),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) =>
        err instanceof PlexApiError &&
        err.detail.kind === "invalid_response" &&
        err.detail.issues.some((i) => i.includes("Metadata.length=3")),
    );
  });

  it("tolerates nullable Plex fields (grandparentTitle/parentTitle/parentYear/duration/thumb = null)", async () => {
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              {
                ratingKey: "1",
                type: "track",
                title: "Bare",
                grandparentTitle: null,
                parentTitle: null,
                parentYear: null,
                duration: null,
                thumb: null,
                Media: [{ Part: [{ file: `${LIB_ROOT}/bare.mp3` }] }],
              },
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 1);
    const t = result.tracks[0]!;
    assert.equal(t.artist, "Unknown artist");
    assert.equal(t.album, "");
    assert.equal(t.albumYear, null);
    assert.equal(t.durationSec, 0);
    assert.equal(t.coverUrl, null);
  });

  it("path_outside_library: rejects `..` traversal (resolved path escapes the root)", async () => {
    const skips: PlexSkipReason[] = [];
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              entry({ ratingKey: "1", title: "Traversal", file: `${LIB_ROOT}/../outside.mp3` }),
              entry({ ratingKey: "2", title: "Prefix Collision", file: `${LIB_ROOT}-evil/file.mp3` }),
              entry({ ratingKey: "3", title: "Deep Traversal", file: `${LIB_ROOT}/subdir/../../etc/passwd` }),
              entry({ ratingKey: "4", title: "Absolute Outside", file: "/etc/shadow" }),
              entry({ ratingKey: "5", title: "Legit", file: `${LIB_ROOT}/real.mp3` }),
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      onSkip: (r) => skips.push(r),
    });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 1, `only 'Legit' should survive — got ${result.tracks.map(t => t.title).join(",")}`);
    assert.equal(result.tracks[0]!.title, "Legit");
    assert.equal(result.skipped, 4);
    assert.equal(skips.filter((s) => s.reason === "path_outside_library").length, 4);
  });

  it("path_outside_library: tolerates a trailing slash on libraryRoot config", async () => {
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [entry({ ratingKey: "1", title: "OK", file: `${LIB_ROOT}/ok.mp3` })],
          }),
        ),
      );
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: `${LIB_ROOT}/`,
    });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 1);
  });

  it("path_outside_library: accepts in-library paths whose names start with dots (e.g. '...And You Will Know Us')", async () => {
    // Regression: a naive `rel.startsWith('..')` parent-escape check
    // would reject real folders like "...And You Will Know Us by the
    // Trail of Dead". They are legitimately inside the library.
    const skips: PlexSkipReason[] = [];
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              entry({
                ratingKey: "1",
                title: "Another Morning Stoner",
                file: `${LIB_ROOT}/...And You Will Know Us by the Trail of Dead/Source Tags & Codes/01 - Another Morning Stoner.mp3`,
              }),
              entry({
                ratingKey: "2",
                title: "Hidden",
                file: `${LIB_ROOT}/.hidden-dir/track.mp3`,
              }),
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      onSkip: (r) => skips.push(r),
    });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 2, `skips=${JSON.stringify(skips)}`);
    assert.equal(result.skipped, 0);
  });

  it("non-track Metadata entries (videos, episodes) are skipped with reason 'not_a_track'", async () => {
    const skips: PlexSkipReason[] = [];
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              entry({ ratingKey: "1", type: "episode", title: "Pilot" }),
              entry({ ratingKey: "2", type: "track", title: "Real Track" }),
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      onSkip: (r) => skips.push(r),
    });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 1);
    assert.equal(result.skipped, 1);
    assert.equal(skips[0]!.reason, "not_a_track");
  });

  it("unsafe-integer ratingKey is skipped with reason 'invalid_rating_key'", async () => {
    const skips: PlexSkipReason[] = [];
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              entry({ ratingKey: "9999999999999999999", title: "Overflow" }),
              entry({ ratingKey: "0", title: "Zero" }),
              entry({ ratingKey: "-1", title: "Negative" }),
              entry({ ratingKey: "abc", title: "Non-numeric" }),
              entry({ ratingKey: "42", title: "OK" }),
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      onSkip: (r) => skips.push(r),
    });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0]!.plexRatingKey, 42);
    assert.equal(skips.filter((s) => s.reason === "invalid_rating_key").length, 4);
  });

  it("body stream termination (not a JSON parse error) is classified as network, not invalid_response", async () => {
    // Simulates Plex dropping the connection after headers are sent but
    // before the body is fully written. fetch() will reject res.json()
    // with a TypeError ("terminated"), not a SyntaxError. Supervisors
    // must treat this as retryable network failure, not malformed data.
    stub.setHandler(async (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.flushHeaders();
      res.write("{\"MediaContainer\":{\"size\":5");
      res.destroy();
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      timeoutMs: 3000,
    });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "network",
    );
  });

  it("body that parses but isn't JSON (HTML page) is classified as invalid_response, not network", async () => {
    stub.setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("<html>Plex UI</html>");
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "invalid_response",
    );
  });

  it("blank/whitespace-only grandparentTitle falls back to 'Unknown artist' with stable hash", async () => {
    // Same identity whether Plex sends null, omits the field, or sends "".
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify({
          MediaContainer: {
            size: 3,
            totalSize: 3,
            Metadata: [
              { ratingKey: "1", type: "track", title: "T", grandparentTitle: null, parentTitle: "A", parentYear: 2020, duration: 100_000, Media: [{ Part: [{ file: `${LIB_ROOT}/a.mp3` }] }] },
              { ratingKey: "2", type: "track", title: "T", grandparentTitle: "",   parentTitle: "A", parentYear: 2020, duration: 100_000, Media: [{ Part: [{ file: `${LIB_ROOT}/b.mp3` }] }] },
              { ratingKey: "3", type: "track", title: "T", grandparentTitle: "   ", parentTitle: "A", parentYear: 2020, duration: 100_000, Media: [{ Part: [{ file: `${LIB_ROOT}/c.mp3` }] }] },
            ],
          },
        }),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 3);
    assert.ok(
      result.tracks.every((tr) => tr.artist === "Unknown artist"),
      `all three should normalize to Unknown artist, got ${result.tracks.map((tr) => tr.artist).join(", ")}`,
    );
    const hashes = new Set(result.tracks.map((tr) => tr.fallbackHash));
    assert.equal(hashes.size, 1, `expected one fallback hash for three identical missing-artist tracks, got ${[...hashes].join(", ")}`);
  });

  it("timeout: when Plex never responds within timeoutMs → PlexApiError{kind:'timeout'}", async () => {
    stub.setHandler(async (_req, res) => {
      await new Promise(() => {});
      res.end();
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      timeoutMs: 150,
    });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) =>
        err instanceof PlexApiError &&
        err.detail.kind === "timeout" &&
        err.detail.timeoutMs === 150,
    );
  });

  it("timeout: when body stalls mid-stream → PlexApiError{kind:'timeout'}", async () => {
    stub.setHandler(async (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.flushHeaders();
      res.write("{");
      await new Promise(() => {});
      res.end();
    });
    const client = createPlexClient({
      baseUrl: stub.url,
      token: "t",
      libraryRoot: LIB_ROOT,
      timeoutMs: 200,
    });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "timeout",
    );
  });

  it("network error (connection refused on known-free port): PlexApiError{kind:'network'}", async () => {
    // Bind to port 0 → kernel assigns one → close → that port is now free
    // with very high probability. More portable than hardcoding 127.0.0.1:1.
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", () => resolve()));
    const freePort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const client = createPlexClient({
      baseUrl: `http://127.0.0.1:${freePort}`,
      token: "t",
      libraryRoot: LIB_ROOT,
      timeoutMs: 2000,
    });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "network",
    );
  });

  it("rejects invalid ratingKey synchronously (0, negative, NaN, float, unsafe-integer)", async () => {
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(() => client.fetchPlaylist(0));
    await assert.rejects(() => client.fetchPlaylist(-1));
    await assert.rejects(() => client.fetchPlaylist(NaN));
    await assert.rejects(() => client.fetchPlaylist(3.14));
    await assert.rejects(() => client.fetchPlaylist(Number.MAX_SAFE_INTEGER + 1));
  });

  it("durationSec rounds to nearest second (500ms rounds up)", async () => {
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify(
          plexPlaylistFixture({
            metadata: [
              entry({ ratingKey: "1", duration: 3_499 }),
              entry({ ratingKey: "2", duration: 3_500 }),
            ],
          }),
        ),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks[0]!.durationSec, 3);
    assert.equal(result.tracks[1]!.durationSec, 4);
  });

  it("paginates when totalSize > page size", async () => {
    // Simulate 3 pages of 2 tracks each = 6 tracks total, totalSize=6.
    stub.setHandler((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
      const page1 = [entry({ ratingKey: "1" }), entry({ ratingKey: "2" })];
      const page2 = [entry({ ratingKey: "3" }), entry({ ratingKey: "4" })];
      const page3 = [entry({ ratingKey: "5" }), entry({ ratingKey: "6" })];
      // The default REQUEST_PAGE_SIZE is 5000, so our single page always
      // satisfies the request. To actually test pagination we simulate a
      // server that artificially pages every 2 entries.
      const all = [...page1, ...page2, ...page3];
      const pageSize = 2;
      const sliced = all.slice(start, start + pageSize);
      res.end(
        JSON.stringify({
          MediaContainer: { size: sliced.length, totalSize: all.length, Metadata: sliced },
        }),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 6);
    assert.deepEqual(
      result.tracks.map((t) => t.plexRatingKey),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(stub.requests.length >= 3, `expected multiple page requests, got ${stub.requests.length}`);
  });

  it("paginates without totalSize: keeps paging until a short page arrives", async () => {
    // Plex sometimes omits totalSize. Ensure we don't stop after the
    // first page just because we can't read a total.
    stub.setHandler((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
      const all = [
        entry({ ratingKey: "10" }),
        entry({ ratingKey: "20" }),
        entry({ ratingKey: "30" }),
        entry({ ratingKey: "40" }),
        entry({ ratingKey: "50" }),
      ];
      const pageSize = 2;
      const sliced = all.slice(start, start + pageSize);
      res.end(
        JSON.stringify({
          // totalSize intentionally omitted.
          MediaContainer: { size: sliced.length, Metadata: sliced },
        }),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    const result = await client.fetchPlaylist(1);
    assert.equal(result.tracks.length, 5);
    assert.deepEqual(
      result.tracks.map((t) => t.plexRatingKey),
      [10, 20, 30, 40, 50],
    );
  });

  it("too-many-tracks: refuses a Plex response claiming totalSize > 50_000", async () => {
    stub.setHandler((_req, res) => {
      res.end(
        JSON.stringify({
          MediaContainer: {
            size: 1,
            totalSize: 100_000,
            Metadata: [entry({ ratingKey: "1" })],
          },
        }),
      );
    });
    const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
    await assert.rejects(
      () => client.fetchPlaylist(1),
      (err: unknown) => err instanceof PlexApiError && err.detail.kind === "too_many_tracks",
    );
  });

  it("PlexApiError.toJSON() serializes cleanly and redacts Error.stack from network.cause", async () => {
    const err = new PlexApiError(
      { kind: "network", cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) },
      "plex network error",
    );
    const json = err.toJSON();
    assert.equal(json.name, "PlexApiError");
    assert.equal(json.message, "plex network error");
    if (json.detail.kind !== "network") throw new Error("expected network kind");
    const cause = json.detail.cause as { name: string; message: string; code: string };
    assert.equal(cause.message, "ECONNREFUSED");
    assert.equal(cause.code, "ECONNREFUSED");
    // Verify that JSON.stringify can round-trip without blowing up on circular stacks.
    const text = JSON.stringify(err);
    assert.ok(text.includes("ECONNREFUSED"));
    assert.equal(text.includes("at "), false, "stack should not be in JSON output");
  });

  it("default onSkip is a no-op — no console spam", async () => {
    const originalWarn = console.warn;
    let warnCalls = 0;
    console.warn = () => {
      warnCalls++;
    };
    try {
      stub.setHandler((_req, res) => {
        res.end(
          JSON.stringify(
            plexPlaylistFixture({
              metadata: [entry({ ratingKey: "1", type: "episode" })],
            }),
          ),
        );
      });
      const client = createPlexClient({ baseUrl: stub.url, token: "t", libraryRoot: LIB_ROOT });
      const result = await client.fetchPlaylist(1);
      assert.equal(result.skipped, 1);
      assert.equal(warnCalls, 0, "default onSkip must not call console.warn");
    } finally {
      console.warn = originalWarn;
    }
  });
});
