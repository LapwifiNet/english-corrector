import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVoiceActivityDetector, frameRms } from "./voiceActivity";

const tone = (level: number, length = 256): Float32Array =>
  Float32Array.from({ length }, () => level);

describe("frameRms", () => {
  it("is zero for an empty frame", () => {
    assert.equal(frameRms(new Float32Array(0)), 0);
  });

  it("matches the level of a steady tone", () => {
    assert.ok(Math.abs(frameRms(tone(0.5, 128)) - 0.5) < 1e-6);
  });
});

describe("createVoiceActivityDetector", () => {
  it("waits for sustained sound before calling it speech", () => {
    const detector = createVoiceActivityDetector({
      minSpeechMs: 100,
      hangoverMs: 200,
    });

    assert.equal(detector.push(tone(0.3), 0).speaking, false);
    assert.equal(detector.push(tone(0.3), 50).speaking, false);
    assert.equal(detector.push(tone(0.3), 100).speaking, true);
  });

  it("ignores a click that stops before the minimum", () => {
    const detector = createVoiceActivityDetector({ minSpeechMs: 100 });

    detector.push(tone(0.4), 0);
    detector.push(tone(0.0001), 40);

    assert.equal(detector.push(tone(0.4), 80).speaking, false);
  });

  it("holds speech through a short pause and closes after the hangover", () => {
    const detector = createVoiceActivityDetector({
      minSpeechMs: 0,
      hangoverMs: 200,
    });

    assert.equal(detector.push(tone(0.3), 0).speaking, true);
    assert.equal(detector.push(tone(0.0001), 100).speaking, true);
    assert.equal(detector.push(tone(0.0001), 200).speaking, false);
  });

  it("remembers the last frame that carried voice", () => {
    const detector = createVoiceActivityDetector({ minSpeechMs: 0 });

    detector.push(tone(0.3), 10);
    detector.push(tone(0.2), 60);

    assert.equal(detector.status().lastVoiceAt, 60);
  });

  it("forgets everything on reset", () => {
    const detector = createVoiceActivityDetector({ minSpeechMs: 0 });

    detector.push(tone(0.3), 0);
    detector.reset();

    assert.deepEqual(detector.status(), {
      speaking: false,
      rms: 0,
      lastVoiceAt: null,
    });
  });
});
