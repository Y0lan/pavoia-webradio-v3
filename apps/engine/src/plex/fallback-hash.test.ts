import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fallbackHash } from "./fallback-hash.ts";

describe("fallbackHash", () => {
  it("is deterministic — same inputs produce the same output", () => {
    const a = fallbackHash("Aphex Twin", "Xtal", "Selected Ambient Works 85-92");
    const b = fallbackHash("Aphex Twin", "Xtal", "Selected Ambient Works 85-92");
    assert.equal(a, b);
  });

  it("produces 16 lowercase hex characters", () => {
    const h = fallbackHash("a", "b", "c");
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it("NFC-normalizes so composed vs decomposed Unicode hash identically", () => {
    // U+00E9 (precomposed) vs U+0065 U+0301 (decomposed)
    const precomposed = fallbackHash("Café", "Song", "Album");
    const decomposed = fallbackHash("Cafe\u0301", "Song", "Album");
    assert.equal(precomposed, decomposed);
  });

  it("trims surrounding whitespace before hashing", () => {
    const tight = fallbackHash("Artist", "Title", "Album");
    const padded = fallbackHash("  Artist  ", "\tTitle\n", " Album ");
    assert.equal(tight, padded);
  });

  it("treats empty strings as stable inputs (not an error)", () => {
    const h = fallbackHash("", "", "");
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it("distinguishes tracks that only differ by album (avoids same-artist-same-title collisions)", () => {
    const live = fallbackHash("Artist", "Song", "Live at Glastonbury");
    const studio = fallbackHash("Artist", "Song", "Debut");
    assert.notEqual(live, studio);
  });

  it("uses a NUL separator so (a|b|c) != (ab||c) — no adjacent-field collisions", () => {
    const split = fallbackHash("ab", "", "c");
    const joined = fallbackHash("a", "bc", "");
    assert.notEqual(split, joined);
  });
});
