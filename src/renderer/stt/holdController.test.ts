import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHoldController, type HoldEvent } from "./holdController";

const FIRST = "i can join the call at three";
const SECOND = "lets use the same link as yesterday";

function harness() {
  const events: HoldEvent[] = [];
  let phraseCount = 0;
  const controller = createHoldController({
    onEvent: (event) => events.push(event),
    createHoldId: () => "hold-1",
    createPhraseId: () => `phrase-${++phraseCount}`,
  });

  return { events, controller };
}

type ClosedPhrase = Extract<HoldEvent, { type: "phrase_closed" }>;

function closed(events: HoldEvent[]): ClosedPhrase[] {
  return events.filter(
    (event): event is ClosedPhrase => event.type === "phrase_closed",
  );
}

describe("createHoldController", () => {
  it("ships several phrases while the key is still held", () => {
    const { events, controller } = harness();
    controller.press(0);

    controller.observe({ speaking: true, at: 900, text: FIRST });
    controller.observe({ speaking: false, at: 1500, text: FIRST });

    controller.observe({ speaking: true, at: 2400, text: SECOND });
    controller.observe({ speaking: false, at: 3000, text: SECOND });

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "hold_started",
        "phrase_opened",
        "phrase_closed",
        "phrase_opened",
        "phrase_closed",
        "phrase_opened",
      ],
    );
    assert.deepEqual(
      closed(events).map((event) => event.phraseIndex),
      [0, 1],
    );
    assert.equal(controller.snapshot().stage, "capturing");
  });

  it("merges a breath that is too short into the next phrase", () => {
    const { events, controller } = harness();
    controller.press(0);

    controller.observe({ speaking: true, at: 200, text: "okay" });
    controller.observe({ speaking: false, at: 800, text: "okay" });
    controller.observe({
      speaking: true,
      at: 1200,
      text: "okay i will send it",
    });
    controller.observe({
      speaking: false,
      at: 1900,
      text: "okay i will send it",
    });

    const closures = closed(events);
    assert.equal(closures.length, 1);
    assert.equal(closures[0]?.words, 5);
    assert.equal(closures[0]?.phraseIndex, 0);
  });

  it("flushes the open phrase on release and ends the hold", () => {
    const { events, controller } = harness();
    controller.press(0);

    controller.observe({ speaking: true, at: 300, text: "thanks" });
    controller.release(600, "thanks");

    const closures = closed(events);
    assert.equal(closures.length, 1);
    assert.equal(closures[0]?.reason, "release");
    assert.deepEqual(events.at(-1), {
      type: "hold_ended",
      holdId: "hold-1",
      endedAt: 600,
      phrases: 1,
      reason: "release",
    });
    assert.deepEqual(controller.snapshot(), {
      stage: "idle",
      holdId: null,
      phrase: null,
      closedPhrases: 0,
    });
  });

  it("cancels the trailing phrase when the release carried no speech", () => {
    const { events, controller } = harness();
    controller.press(0);

    controller.observe({ speaking: true, at: 900, text: FIRST });
    controller.observe({ speaking: false, at: 1500, text: FIRST });
    controller.release(1700, FIRST);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "hold_started",
        "phrase_opened",
        "phrase_closed",
        "phrase_opened",
        "phrase_cancelled",
        "hold_ended",
      ],
    );
    assert.equal(closed(events).length, 1);
  });

  it("restarts phrase indexes on the next hold", () => {
    const { events, controller } = harness();
    controller.press(0);
    controller.observe({ speaking: true, at: 300, text: "thanks" });
    controller.release(600, "thanks");
    events.length = 0;

    controller.press(5000);
    const opened = events.find((event) => event.type === "phrase_opened");
    assert.equal(opened?.type === "phrase_opened" && opened.phraseIndex, 0);
  });

  it("drops the open phrase but keeps capturing on cancelPhrase", () => {
    const { events, controller } = harness();
    controller.press(0);
    controller.observe({ speaking: true, at: 300, text: "wrong words" });
    controller.cancelPhrase(400);

    assert.deepEqual(
      events.map((event) => event.type),
      ["hold_started", "phrase_opened", "phrase_cancelled", "phrase_opened"],
    );
    assert.equal(controller.snapshot().stage, "capturing");
    assert.equal(controller.snapshot().phrase?.phraseIndex, 1);
  });

  it("stops emitting phrases after the hold is cancelled", () => {
    const { events, controller } = harness();
    controller.press(0);
    controller.observe({ speaking: true, at: 300, text: FIRST });
    controller.cancelHold(400);
    events.length = 0;

    const sample = { speaking: true, at: 500, text: FIRST };
    assert.deepEqual(controller.observe(sample), {
      endpoint: false,
      heldBack: "not_open",
    });
    assert.deepEqual(events, []);
  });
});
