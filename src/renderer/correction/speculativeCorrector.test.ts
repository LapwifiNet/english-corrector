import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CorrectionRequest, CorrectionResult } from "./contracts";
import type { CorrectionEngine, ScheduleTimeout } from "./correctionEngine";
import {
  createSpeculativeCorrector,
  normalizeForSpeculation,
  type SpeculationOutcome,
} from "./speculativeCorrector";

type Call = {
  request: CorrectionRequest;
  signal?: AbortSignal;
  reply: (correctedText: string) => void;
};

function fakeEngine(): { engine: CorrectionEngine; calls: Call[] } {
  const calls: Call[] = [];
  const engine: CorrectionEngine = {
    correct: (request, options) =>
      new Promise<CorrectionResult>((resolve, reject) => {
        const signal = options?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
        calls.push({
          request,
          signal,
          reply: (correctedText) =>
            resolve({
              phraseId: request.phraseId,
              originalText: request.originalText,
              correctedText,
              outcome: "changed",
              warnings: [],
              promptVersion: "test",
            }),
        });
      }),
  };

  return { engine, calls };
}

function manualTimers() {
  const timers: Array<{ fn: () => void }> = [];
  const scheduleTimeout: ScheduleTimeout = (_ms, fn) => {
    const entry = { fn };
    timers.push(entry);
    return () => {
      const index = timers.indexOf(entry);
      if (index >= 0) timers.splice(index, 1);
    };
  };

  return {
    scheduleTimeout,
    pending: () => timers.length,
    flush: () => {
      for (const entry of timers.splice(0, timers.length)) entry.fn();
    },
  };
}

function setup() {
  const { engine, calls } = fakeEngine();
  const clock = manualTimers();
  const outcomes: SpeculationOutcome[] = [];
  const corrector = createSpeculativeCorrector({
    engine,
    scheduleTimeout: clock.scheduleTimeout,
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  return { corrector, calls, clock, outcomes };
}

describe("normalizeForSpeculation", () => {
  it("ignores casing, punctuation and spacing", () => {
    assert.equal(
      normalizeForSpeculation("  I can  join, at three! "),
      "i can join at three",
    );
  });
});

describe("createSpeculativeCorrector", () => {
  it("waits for the partial to hold still before calling", () => {
    const { corrector, calls, clock } = setup();

    corrector.observe("hold-1:0", "i want");
    corrector.observe("hold-1:0", "i want to check");
    assert.equal(calls.length, 0);

    clock.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.request.originalText, "i want to check");
  });

  it("leaves a partial too short to guess from alone", () => {
    const { corrector, calls, clock } = setup();

    corrector.observe("hold-1:0", "i want");
    clock.flush();

    assert.equal(calls.length, 0);
    assert.equal(clock.pending(), 0);
  });

  it("reuses the guess when the final only adds punctuation", async () => {
    const { corrector, calls, clock, outcomes } = setup();

    corrector.observe("hold-1:0", "i can join the call at three");
    clock.flush();
    const claimed = corrector.take("hold-1:0", "I can join the call at three.");
    assert.ok(claimed);

    calls[0]?.reply("I can join the call at three.");
    const result = await claimed;

    assert.equal(calls.length, 1);
    assert.deepEqual(outcomes, ["hit"]);
    assert.equal(result.correctedText, "I can join the call at three.");
    assert.equal(result.originalText, "I can join the call at three.");
    assert.equal(result.phraseId, "hold-1:0");
  });

  it("drops a guess the finished sentence no longer matches", () => {
    const { corrector, calls, clock, outcomes } = setup();

    corrector.observe("hold-1:0", "i can join the call");
    clock.flush();
    const claimed = corrector.take("hold-1:0", "I can join the call at three.");

    assert.equal(claimed, null);
    assert.equal(calls[0]?.signal?.aborted, true);
    assert.deepEqual(outcomes, ["stale"]);
  });

  it("never hands a guess to a different phrase", () => {
    const { corrector, clock, outcomes } = setup();

    corrector.observe("hold-1:0", "i can join the call");
    clock.flush();

    assert.equal(corrector.take("hold-1:1", "i can join the call"), null);
    assert.deepEqual(outcomes, ["stale"]);
  });

  it("reports a cold claim when nothing was guessed", () => {
    const { corrector, outcomes } = setup();

    assert.equal(corrector.take("hold-1:0", "I can join."), null);
    assert.deepEqual(outcomes, ["cold"]);
  });

  it("supersedes a guess when the speaker keeps going", () => {
    const { corrector, calls, clock } = setup();

    corrector.observe("hold-1:0", "i can join the call");
    clock.flush();
    corrector.observe("hold-1:0", "i can join the call at three");
    clock.flush();

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.signal?.aborted, true);
    assert.equal(calls[1]?.signal?.aborted, false);
  });

  it("discards the pending timer and the call in flight", () => {
    const { corrector, calls, clock } = setup();

    corrector.observe("hold-1:0", "i can join the call");
    clock.flush();
    corrector.observe("hold-1:0", "i can join the call at three");
    corrector.discard();
    clock.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.signal?.aborted, true);
  });
});
