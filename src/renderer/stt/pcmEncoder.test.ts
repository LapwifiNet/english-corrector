import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodePcmChunk, floatToPcm16, resampleLinear } from "./pcmEncoder";

describe("resampleLinear", () => {
  it("returns the same samples when the rate already matches", () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);

    assert.equal(resampleLinear(samples, 16_000, 16_000), samples);
  });

  it("shrinks 48 kHz audio to a third of the samples at 16 kHz", () => {
    const samples = new Float32Array(480);

    assert.equal(resampleLinear(samples, 48_000, 16_000).length, 160);
  });

  it("interpolates between neighbouring samples", () => {
    const output = resampleLinear(
      new Float32Array([0, 1, 0, 1]),
      32_000,
      16_000,
    );

    assert.deepEqual(Array.from(output), [0, 0]);
  });

  it("guards against an unusable rate", () => {
    assert.equal(resampleLinear(new Float32Array([1]), 0, 16_000).length, 0);
  });
});

describe("floatToPcm16", () => {
  it("clamps samples outside the signed range", () => {
    const output = floatToPcm16(new Float32Array([2, -2, 0]));

    assert.equal(output[0], 32_767);
    assert.equal(output[1], -32_768);
    assert.equal(output[2], 0);
  });
});

describe("encodePcmChunk", () => {
  it("produces two bytes per resampled sample", () => {
    const chunk = encodePcmChunk(new Float32Array(480), 48_000, 16_000);

    assert.equal(chunk.byteLength, 320);
  });

  it("produces nothing for an empty frame", () => {
    assert.equal(
      encodePcmChunk(new Float32Array(0), 48_000, 16_000).byteLength,
      0,
    );
  });
});
