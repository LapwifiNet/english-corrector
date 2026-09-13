import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PcmFormatError, PcmStreamNormalizer } from "./pcmNormalizer";

function s16Bytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

describe("PcmStreamNormalizer", () => {
  it("duplicates mono s16 audio into stereo float channels", () => {
    const normalizer = new PcmStreamNormalizer({
      sampleRate: 48_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    const frame = normalizer.push(s16Bytes([0, 16_384, -16_384]))!;

    assert.equal(frame.frameCount, 3);
    assert.deepEqual([...frame.channels[0]], [...frame.channels[1]]);
    assert.ok(Math.abs(frame.channels[0][1]! - 0.5) < 0.0001);
    assert.ok(Math.abs(frame.channels[0][2]! + 0.5) < 0.0001);
  });

  it("resamples 24 kHz input to 48 kHz", () => {
    const normalizer = new PcmStreamNormalizer({
      sampleRate: 24_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    const frame = normalizer.push(s16Bytes([0, 8_192, 16_384, 24_576]))!;
    assert.equal(frame.frameCount, 8);
  });

  it("preserves incomplete bytes until a complete frame arrives", () => {
    const normalizer = new PcmStreamNormalizer({
      sampleRate: 48_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    assert.equal(normalizer.push(Uint8Array.of(0)), null);
    assert.equal(normalizer.push(Uint8Array.of(64))?.frameCount, 1);
    assert.doesNotThrow(() => normalizer.finish());
  });

  it("rejects unsupported sample rates", () => {
    assert.throws(
      () =>
        new PcmStreamNormalizer({
          sampleRate: 192_000,
          channels: 1,
          encoding: "pcm_f32le",
        }),
      PcmFormatError,
    );
  });
});
