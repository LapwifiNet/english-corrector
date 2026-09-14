import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CorrectionBridge,
  CorrectionBridgeRequest,
  CorrectionBridgeResponse,
} from "../../shared/correction";
import type { CorrectionRequest } from "./contracts";
import { createCorrectionEngine } from "./correctionEngine";
import {
  CorrectionProviderFailure,
  createIpcCorrectionAdapter,
} from "./ipcCorrectionAdapter";

function request(originalText: string): CorrectionRequest {
  return { phraseId: "phrase-1", originalText, locale: "en" };
}

function fakeBridge(response: CorrectionBridgeResponse): {
  bridge: CorrectionBridge;
  calls: CorrectionBridgeRequest[];
} {
  const calls: CorrectionBridgeRequest[] = [];
  const bridge: CorrectionBridge = {
    getStatus: async () => ({
      provider: "openai-compatible",
      configured: true,
      modelId: "test-model",
      timeoutMs: 1500,
      missing: [],
    }),
    correct: async (value) => {
      calls.push(value);
      return response;
    },
  };

  return { bridge, calls };
}

describe("createIpcCorrectionAdapter", () => {
  it("forwards the phrase and returns the corrected text", async () => {
    const { bridge, calls } = fakeBridge({
      ok: true,
      text: "She goes to school.",
      providerLatencyMs: 120,
    });
    const adapter = createIpcCorrectionAdapter(bridge);

    const text = await adapter.correct(
      request("she go to school"),
      new AbortController().signal,
    );

    assert.equal(adapter.name, "ipc");
    assert.equal(text, "She goes to school.");
    assert.deepEqual(calls, [
      { phraseId: "phrase-1", originalText: "she go to school" },
    ]);
  });

  it("throws the provider code when the bridge reports a failure", async () => {
    const { bridge } = fakeBridge({
      ok: false,
      code: "provider_rate_limited",
      providerLatencyMs: 40,
    });
    const adapter = createIpcCorrectionAdapter(bridge);

    await assert.rejects(
      adapter.correct(
        request("she go to school"),
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CorrectionProviderFailure);
        assert.equal(error.code, "provider_rate_limited");
        return true;
      },
    );
  });

  it("does not call the bridge once the phrase is cancelled", async () => {
    const { bridge, calls } = fakeBridge({
      ok: true,
      text: "She goes to school.",
      providerLatencyMs: 10,
    });
    const adapter = createIpcCorrectionAdapter(bridge);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      adapter.correct(request("she go to school"), controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, "AbortError");
        return true;
      },
    );

    assert.equal(calls.length, 0);
  });
});

describe("correction engine over the bridge", () => {
  it("returns a changed result when the provider answers", async () => {
    const { bridge } = fakeBridge({
      ok: true,
      text: "He goes to the office every Monday.",
      providerLatencyMs: 210,
    });
    const engine = createCorrectionEngine({
      adapter: createIpcCorrectionAdapter(bridge),
      now: () => 0,
    });

    const result = await engine.correct(
      request("he go to the office every Monday"),
    );

    assert.equal(result.outcome, "changed");
    assert.equal(result.correctedText, "He goes to the office every Monday.");
    assert.deepEqual(result.warnings, []);
  });

  it("falls back to the original text when the provider fails", async () => {
    const { bridge } = fakeBridge({
      ok: false,
      code: "provider_not_configured",
      providerLatencyMs: 0,
    });
    const engine = createCorrectionEngine({
      adapter: createIpcCorrectionAdapter(bridge),
      now: () => 0,
    });

    const result = await engine.correct(request("he go to the office"));

    assert.equal(result.outcome, "fallback");
    assert.equal(result.errorCode, "provider_error");
    assert.equal(result.correctedText, "he go to the office");
  });
});
