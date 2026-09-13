import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TtsEvent } from "./contracts";
import { FakeTtsAdapter, synthesizeDiagnosticPcm } from "./fakeTtsAdapter";

const request = {
  utteranceId: "utterance-1",
  text: "Hello streaming world",
  voiceId: "diagnostic-pcm",
};

describe("FakeTtsAdapter", () => {
  it("emits a deterministic started, chunk, completed stream", async () => {
    const adapter = new FakeTtsAdapter({ chunkBytes: 512, chunkDelayMs: 0 });
    const events: TtsEvent[] = [];

    for await (const event of adapter.synthesize(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "started");
    assert.equal(events.at(-1)?.type, "completed");
    const chunks = events.filter((event) => event.type === "chunk");
    assert.ok(chunks.length > 1);
    assert.deepEqual(
      chunks.map((chunk) => chunk.sequence),
      chunks.map((_, index) => index),
    );
  });

  it("produces the same PCM bytes for the same text", () => {
    assert.deepEqual(
      synthesizeDiagnosticPcm("Same text"),
      synthesizeDiagnosticPcm("Same text"),
    );
  });

  it("maps a simulated provider failure to a failed event", async () => {
    const adapter = new FakeTtsAdapter({
      chunkBytes: 128,
      chunkDelayMs: 0,
      failAtSequence: 1,
    });
    const events: TtsEvent[] = [];

    for await (const event of adapter.synthesize(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    assert.equal(events.at(-1)?.type, "failed");
  });

  it("stops immediately when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new FakeTtsAdapter();

    await assert.rejects(
      async () => {
        for await (const _event of adapter.synthesize(
          request,
          controller.signal,
        )) {
          // Iteration itself is the behavior under test.
        }
      },
      { name: "AbortError" },
    );
  });
});
