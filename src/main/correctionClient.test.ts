import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CORRECTION_TEXT_LENGTH,
  type CorrectionBridgeErrorCode,
} from "../shared/correction";
import { CORRECTION_SYSTEM_INSTRUCTION } from "../shared/correctionPrompt";
import {
  CorrectionProviderError,
  correctionProviderErrorCode,
  readCorrectionProviderStatus,
  readCorrectionRuntimeConfig,
  requestCorrection,
  type CorrectionFetch,
  type CorrectionRuntimeConfig,
} from "./correctionClient";

type FetchCall = { url: string; init: Parameters<CorrectionFetch>[1] };

type RequestBody = {
  model: string;
  temperature: number;
  top_p: number;
  n: number;
  max_tokens: number;
  messages: Array<{ role: string; content: string }>;
};

const config: CorrectionRuntimeConfig = {
  apiKey: "secret-key",
  baseUrl: "https://provider.test/v1",
  modelId: "test-model",
  timeoutMs: 1500,
};

function environment(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function fakeFetch(response: {
  ok: boolean;
  status: number;
  payload: unknown;
}): { fetchImpl: CorrectionFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: CorrectionFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.payload,
    };
  };

  return { fetchImpl, calls };
}

function completion(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

function phrase(originalText: string) {
  return { phraseId: "phrase-1", originalText };
}

describe("readCorrectionProviderStatus", () => {
  it("reports the missing api key", () => {
    const status = readCorrectionProviderStatus(environment({}));

    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, ["CORRECTION_API_KEY"]);
    assert.equal(status.modelId, "gpt-4o-mini");
    assert.equal(status.timeoutMs, 1500);
  });

  it("clamps the timeout to the supported range", () => {
    const high = readCorrectionProviderStatus(
      environment({ CORRECTION_API_KEY: "k", CORRECTION_TIMEOUT_MS: "99999" }),
    );
    const low = readCorrectionProviderStatus(
      environment({ CORRECTION_API_KEY: "k", CORRECTION_TIMEOUT_MS: "10" }),
    );
    const invalid = readCorrectionProviderStatus(
      environment({ CORRECTION_API_KEY: "k", CORRECTION_TIMEOUT_MS: "soon" }),
    );

    assert.equal(high.configured, true);
    assert.equal(high.timeoutMs, 5000);
    assert.equal(low.timeoutMs, 300);
    assert.equal(invalid.timeoutMs, 1500);
  });
});

describe("readCorrectionRuntimeConfig", () => {
  it("returns null when the provider is not configured", () => {
    assert.equal(readCorrectionRuntimeConfig(environment({})), null);
  });

  it("trims the base url and keeps the configured model", () => {
    const runtime = readCorrectionRuntimeConfig(
      environment({
        CORRECTION_API_KEY: "k",
        CORRECTION_BASE_URL: "https://provider.test/v1/",
        CORRECTION_MODEL_ID: "m",
      }),
    );

    assert.deepEqual(runtime, {
      apiKey: "k",
      baseUrl: "https://provider.test/v1",
      modelId: "m",
      timeoutMs: 1500,
    });
  });
});

describe("requestCorrection", () => {
  it("sends one deterministic request and returns trimmed text", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ok: true,
      status: 200,
      payload: completion("  She goes to school.  "),
    });

    const text = await requestCorrection({
      request: phrase("she go to school"),
      config,
      signal: new AbortController().signal,
      fetchImpl,
    });

    assert.equal(text, "She goes to school.");
    assert.equal(calls.length, 1);

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, "https://provider.test/v1/chat/completions");
    assert.equal(call.init.headers.Authorization, "Bearer secret-key");

    const body = JSON.parse(call.init.body) as RequestBody;
    assert.equal(body.model, "test-model");
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 1);
    assert.equal(body.n, 1);
    assert.equal(body.max_tokens, 200);
    assert.equal(body.messages[0]?.content, CORRECTION_SYSTEM_INSTRUCTION);
    assert.equal(body.messages[1]?.content, "she go to school");
  });

  it("maps provider status codes to domain error codes", async () => {
    const cases: Array<[number, CorrectionBridgeErrorCode]> = [
      [401, "provider_auth_error"],
      [403, "provider_auth_error"],
      [429, "provider_rate_limited"],
      [400, "provider_request_error"],
      [503, "provider_unavailable"],
    ];

    for (const [status, code] of cases) {
      const { fetchImpl } = fakeFetch({ ok: false, status, payload: {} });

      await assert.rejects(
        requestCorrection({
          request: phrase("she go to school"),
          config,
          signal: new AbortController().signal,
          fetchImpl,
        }),
        (error: unknown) => {
          assert.ok(error instanceof CorrectionProviderError);
          assert.equal(error.code, code);
          return true;
        },
      );
    }
  });

  it("rejects an empty provider answer", async () => {
    const { fetchImpl } = fakeFetch({
      ok: true,
      status: 200,
      payload: completion("   "),
    });

    await assert.rejects(
      requestCorrection({
        request: phrase("she go to school"),
        config,
        signal: new AbortController().signal,
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CorrectionProviderError);
        assert.equal(error.code, "provider_empty_output");
        return true;
      },
    );
  });

  it("never calls the provider for text over the budget", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ok: true,
      status: 200,
      payload: completion("ignored"),
    });

    await assert.rejects(
      requestCorrection({
        request: phrase("a".repeat(MAX_CORRECTION_TEXT_LENGTH + 1)),
        config,
        signal: new AbortController().signal,
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CorrectionProviderError);
        assert.equal(error.code, "provider_request_error");
        return true;
      },
    );

    assert.equal(calls.length, 0);
  });
});

describe("correctionProviderErrorCode", () => {
  it("maps an aborted call to a timeout", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";

    assert.equal(correctionProviderErrorCode(aborted), "provider_timeout");
    assert.equal(
      correctionProviderErrorCode(new Error("socket hang up")),
      "provider_unavailable",
    );
  });
});
