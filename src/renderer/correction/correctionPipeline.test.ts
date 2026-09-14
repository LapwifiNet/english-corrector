import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CorrectionAdapter } from "./contracts";
import { createCorrectionEngine } from "./correctionEngine";
import {
  createCorrectionPipeline,
  isSpeakable,
  type CorrectionSnapshot,
} from "./correctionPipeline";
import { createFakeCorrector, createManualTimer } from "./fakeCorrector";

type Deferred = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

function pipelineWith(
  adapter: CorrectionAdapter,
  options: { enabled?: boolean } = {},
) {
  const timer = createManualTimer();
  const snapshots: CorrectionSnapshot[] = [];
  const pipeline = createCorrectionPipeline({
    engine: createCorrectionEngine({
      adapter,
      scheduleTimeout: timer.schedule,
      now: () => 0,
    }),
    enabled: options.enabled,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  return { pipeline, snapshots, timer };
}

function deferredAdapter(): {
  adapter: CorrectionAdapter;
  pending: Map<string, Deferred>;
} {
  const pending = new Map<string, Deferred>();
  const adapter: CorrectionAdapter = {
    name: "deferred",
    correct: (request) =>
      new Promise<string>((resolve, reject) => {
        pending.set(request.phraseId, { resolve, reject });
      }),
  };

  return { adapter, pending };
}

describe("correction pipeline", () => {
  it("speaks the corrected sentence for a final transcript", async () => {
    const adapter = createFakeCorrector({
      type: "fixed",
      output: "He goes to the office every Monday.",
    });
    const { pipeline, snapshots } = pipelineWith(adapter);

    const snapshot = await pipeline.submit(
      "phrase-1",
      "he go to the office every Monday",
    );

    assert.equal(snapshot.phase, "done");
    assert.equal(snapshot.spokenText, "He goes to the office every Monday.");
    assert.equal(snapshot.originalText, "he go to the office every Monday");
    assert.equal(snapshot.result?.outcome, "changed");
    assert.equal(isSpeakable(snapshot), true);
    assert.deepEqual(
      snapshots.map((item) => item.phase),
      ["correcting", "done"],
    );
  });

  it("speaks the original sentence when correction falls back", async () => {
    const adapter = createFakeCorrector({ type: "error" });
    const { pipeline } = pipelineWith(adapter);

    const snapshot = await pipeline.submit("phrase-1", "he go to the office");

    assert.equal(snapshot.phase, "done");
    assert.equal(snapshot.spokenText, "he go to the office");
    assert.equal(snapshot.result?.outcome, "fallback");
    assert.equal(snapshot.result?.errorCode, "provider_error");
    assert.equal(isSpeakable(snapshot), true);
  });

  it("skips the engine in diagnostic mode", async () => {
    const adapter = createFakeCorrector({ type: "echo" });
    const { pipeline } = pipelineWith(adapter, { enabled: false });

    const snapshot = await pipeline.submit("phrase-1", "he go to the office");

    assert.equal(pipeline.isEnabled(), false);
    assert.equal(snapshot.phase, "skipped");
    assert.equal(snapshot.spokenText, "he go to the office");
    assert.equal(snapshot.result, null);
    assert.equal(adapter.callCount, 0);
  });

  it("skips an empty final transcript", async () => {
    const adapter = createFakeCorrector({ type: "echo" });
    const { pipeline } = pipelineWith(adapter);

    const snapshot = await pipeline.submit("phrase-1", "   ");

    assert.equal(snapshot.phase, "skipped");
    assert.equal(snapshot.spokenText, "");
    assert.equal(isSpeakable(snapshot), false);
    assert.equal(adapter.callCount, 0);
  });

  it("never speaks a cancelled phrase", async () => {
    const adapter = createFakeCorrector({ type: "never" });
    const { pipeline } = pipelineWith(adapter);

    const pending = pipeline.submit("phrase-1", "he go to the office");
    pipeline.cancel("phrase-1");
    const snapshot = await pending;

    assert.equal(snapshot.phase, "cancelled");
    assert.equal(snapshot.spokenText, "");
    assert.equal(isSpeakable(snapshot), false);
  });

  it("ignores a cancel that names another phrase", async () => {
    const adapter = createFakeCorrector({
      type: "fixed",
      output: "She goes to school.",
    });
    const { pipeline } = pipelineWith(adapter);

    const pending = pipeline.submit("phrase-1", "she go to school");
    pipeline.cancel("phrase-2");
    const snapshot = await pending;

    assert.equal(snapshot.phase, "done");
    assert.equal(snapshot.spokenText, "She goes to school.");
  });

  it("turning correction off cancels the phrase in flight", async () => {
    const adapter = createFakeCorrector({ type: "never" });
    const { pipeline } = pipelineWith(adapter);

    const pending = pipeline.submit("phrase-1", "she go to school");
    pipeline.setEnabled(false);
    const snapshot = await pending;

    assert.equal(snapshot.phase, "cancelled");
    assert.equal(pipeline.isEnabled(), false);
  });

  it("lets a newer phrase supersede the one still in flight", async () => {
    const { adapter, pending } = deferredAdapter();
    const { pipeline } = pipelineWith(adapter);

    const first = pipeline.submit("phrase-1", "she go to school");
    const second = pipeline.submit("phrase-2", "he go to the office");

    pending.get("phrase-2")?.resolve("He goes to the office.");
    const secondSnapshot = await second;
    pending.get("phrase-1")?.resolve("She goes to school.");
    await first;

    assert.equal(secondSnapshot.phraseId, "phrase-2");
    assert.equal(secondSnapshot.spokenText, "He goes to the office.");
    assert.equal(pipeline.snapshot().phraseId, "phrase-2");
    assert.equal(pipeline.snapshot().phase, "done");
  });
});
