import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PushToTalkController } from "./phraseController";

describe("PushToTalkController", () => {
  it("creates exactly one phrase for press, repeat, and release", () => {
    let id = 0;
    let now = 100;
    const controller = new PushToTalkController(
      () => `phrase-${++id}`,
      () => now,
    );

    assert.deepEqual(controller.press(), {
      type: "capture_started",
      phraseId: "phrase-1",
      startedAt: 100,
    });
    assert.equal(controller.press(), null);

    now = 250;
    assert.deepEqual(controller.release(), {
      type: "capture_ended",
      phraseId: "phrase-1",
      endedAt: 250,
    });
    assert.equal(controller.release(), null);
    assert.equal(controller.press(), null);
  });

  it("accepts a new phrase after the active phrase completes", () => {
    let id = 0;
    const controller = new PushToTalkController(() => `phrase-${++id}`);

    controller.press();
    controller.release();
    assert.equal(controller.complete("another-phrase"), false);
    assert.equal(controller.complete("phrase-1"), true);
    assert.equal(controller.press()?.phraseId, "phrase-2");
  });

  it("cancels once and returns to ready", () => {
    const controller = new PushToTalkController(() => "phrase-1");
    controller.press();

    assert.deepEqual(controller.cancel(), {
      type: "cancelled",
      phraseId: "phrase-1",
    });
    assert.equal(controller.cancel(), null);
    assert.deepEqual(controller.snapshot(), { stage: "ready", phraseId: null });
  });
});
