import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createThreeToneWavBlob } from "./testFixture";

describe("createThreeToneWavBlob", () => {
  it("creates a mono PCM WAV fixture with RIFF and WAVE headers", async () => {
    const blob = createThreeToneWavBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder();

    assert.equal(blob.type, "audio/wav");
    assert.ok(blob.size > 44);
    assert.equal(text.decode(bytes.slice(0, 4)), "RIFF");
    assert.equal(text.decode(bytes.slice(8, 12)), "WAVE");
  });
});
