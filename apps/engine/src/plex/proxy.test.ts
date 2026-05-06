import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import { createPlexProxy, rewriteThumbToProxy } from "./proxy.ts";

describe("rewriteThumbToProxy", () => {
  it("rewrites a well-formed Plex thumb path", () => {
    assert.equal(
      rewriteThumbToProxy("/library/metadata/149097/thumb/1774577227"),
      "/api/plex/thumb/149097/1774577227",
    );
  });

  it("returns null for null/undefined/empty", () => {
    assert.equal(rewriteThumbToProxy(null), null);
    assert.equal(rewriteThumbToProxy(undefined), null);
    assert.equal(rewriteThumbToProxy(""), null);
  });

  it("returns null for non-thumb Plex paths", () => {
    assert.equal(rewriteThumbToProxy("/library/metadata/149097"), null);
    assert.equal(
      rewriteThumbToProxy("/library/metadata/149097/art/1774577227"),
      null,
    );
    assert.equal(rewriteThumbToProxy("https://example.com/cover.jpg"), null);
  });

  it("rejects non-numeric segments (defense against shape drift)", () => {
    assert.equal(
      rewriteThumbToProxy("/library/metadata/abc/thumb/1234"),
      null,
    );
    assert.equal(
      rewriteThumbToProxy("/library/metadata/123/thumb/abc"),
      null,
    );
  });
});

describe("createPlexProxy — /thumb", () => {
  function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const fn = handlers[url];
      if (!fn) {
        throw new Error(`unmocked fetch: ${url}`);
      }
      return fn();
    }) as unknown as typeof fetch;
  }

  function mount(opts: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    token?: string;
  }): Hono {
    const app = new Hono();
    app.route(
      "/api/plex",
      createPlexProxy({
        baseUrl: opts.baseUrl ?? "http://127.0.0.1:31711",
        token: opts.token ?? "TKN",
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    return app;
  }

  it("forwards a valid thumb GET to Plex with X-Plex-Token", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      captured = { url, headers };
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      });
    }) as unknown as typeof fetch;

    const app = mount({ fetchImpl });
    const res = await app.request("/api/plex/thumb/149097/1774577227");

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control") ?? "", /max-age=86400/);
    assert.equal(
      captured!.url,
      "http://127.0.0.1:31711/library/metadata/149097/thumb/1774577227",
    );
    assert.equal(captured!.headers["x-plex-token"], "TKN");
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Array.from(buf), [0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects non-numeric metadata key", async () => {
    const app = mount({});
    const res = await app.request("/api/plex/thumb/abc/1234");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_thumb_id");
  });

  it("rejects non-numeric thumb id", async () => {
    const app = mount({});
    const res = await app.request("/api/plex/thumb/149097/abc");
    assert.equal(res.status, 400);
  });

  it("returns 404 when Plex returns 404", async () => {
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:31711/library/metadata/1/thumb/2": () =>
        new Response("not found", { status: 404 }),
    });
    const app = mount({ fetchImpl });
    const res = await app.request("/api/plex/thumb/1/2");
    assert.equal(res.status, 404);
  });

  it("returns 502 when Plex returns 5xx", async () => {
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:31711/library/metadata/1/thumb/2": () =>
        new Response("upstream pop", { status: 503 }),
    });
    const app = mount({ fetchImpl });
    const res = await app.request("/api/plex/thumb/1/2");
    assert.equal(res.status, 502);
  });

  it("returns 502 on network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = mount({ fetchImpl });
    const res = await app.request("/api/plex/thumb/1/2");
    assert.equal(res.status, 502);
  });

  it("rejects oversized thumbs (defense against pathological upstream)", async () => {
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:31711/library/metadata/1/thumb/2": () =>
        new Response("body-omitted", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(50 * 1024 * 1024), // 50 MB
          },
        }),
    });
    const app = mount({ fetchImpl });
    const res = await app.request("/api/plex/thumb/1/2");
    assert.equal(res.status, 502);
  });

  it("strips trailing slash from baseUrl", async () => {
    let captured: string | null = null;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      captured = typeof input === "string" ? input : input.toString();
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const app = mount({
      fetchImpl,
      baseUrl: "http://127.0.0.1:31711///",
    });
    await app.request("/api/plex/thumb/9/8");
    assert.equal(
      captured,
      "http://127.0.0.1:31711/library/metadata/9/thumb/8",
    );
  });
});

describe("createPlexProxy — /artist", () => {
  function makeFetch(handlers: Record<string, () => Response>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const fn = handlers[url];
      if (!fn) throw new Error(`unmocked fetch: ${url}`);
      return fn();
    }) as unknown as typeof fetch;
  }

  function mount(fetchImpl: typeof fetch): Hono {
    const app = new Hono();
    app.route(
      "/api/plex",
      createPlexProxy({
        baseUrl: "http://127.0.0.1:31711",
        token: "TKN",
        fetchImpl,
      }),
    );
    return app;
  }

  it("returns a clean PublicArtist on the happy path with similar artists", async () => {
    const fetchImpl = makeFetch({
      "http://127.0.0.1:31711/library/metadata/1234": () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "1234",
                  type: "artist",
                  title: "Stereociti",
                  summary: "An act from somewhere.",
                  thumb: "/library/metadata/1234/thumb/9999",
                  Country: [{ tag: "Japan" }],
                  Genre: [{ tag: "House" }, { tag: "Tech House" }],
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "http://127.0.0.1:31711/library/metadata/1234/similar": () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "9001",
                  type: "artist",
                  title: "Various Artists",
                  thumb: "/library/metadata/9001/thumb/8888",
                },
                { ratingKey: "9002", type: "track", title: "stray track" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const app = mount(fetchImpl);
    const res = await app.request("/api/plex/artist/1234");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      ratingKey: "1234",
      title: "Stereociti",
      summary: "An act from somewhere.",
      thumb: "/api/plex/thumb/1234/9999",
      country: ["Japan"],
      genre: ["House", "Tech House"],
      similar: [
        {
          ratingKey: "9001",
          title: "Various Artists",
          thumb: "/api/plex/thumb/9001/8888",
        },
      ],
    });
  });

  it("returns 404 when artist doesn't exist", async () => {
    const fetchImpl = makeFetch({
      "http://127.0.0.1:31711/library/metadata/1234": () =>
        new Response(
          JSON.stringify({ MediaContainer: { Metadata: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const app = mount(fetchImpl);
    const res = await app.request("/api/plex/artist/1234");
    assert.equal(res.status, 404);
  });

  it("returns 400 when key resolves to a non-artist", async () => {
    const fetchImpl = makeFetch({
      "http://127.0.0.1:31711/library/metadata/1234": () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                { ratingKey: "1234", type: "track", title: "A song" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const app = mount(fetchImpl);
    const res = await app.request("/api/plex/artist/1234");
    assert.equal(res.status, 400);
  });

  it("returns artist with empty similar[] when /similar 404s (Plex feature off)", async () => {
    const fetchImpl = makeFetch({
      "http://127.0.0.1:31711/library/metadata/1234": () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "1234",
                  type: "artist",
                  title: "Stereociti",
                  summary: "",
                  thumb: null,
                  Country: [],
                  Genre: [],
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "http://127.0.0.1:31711/library/metadata/1234/similar": () =>
        new Response("Not found", { status: 404 }),
    });
    const app = mount(fetchImpl);
    const res = await app.request("/api/plex/artist/1234");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { similar: unknown[]; thumb: unknown };
    assert.deepEqual(body.similar, []);
    assert.equal(body.thumb, null);
  });

  it("rejects non-numeric ratingKey", async () => {
    const app = mount(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    );
    const res = await app.request("/api/plex/artist/abc");
    assert.equal(res.status, 400);
  });

  it("returns 502 when Plex is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = mount(fetchImpl);
    const res = await app.request("/api/plex/artist/1234");
    assert.equal(res.status, 502);
  });
});
