import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listPalabraVoices,
  type PalabraVoiceFetch,
  type PalabraVoiceFetchResponse,
} from "./palabraVoices";

const config = {
  apiKey: "secret-api-key",
  voiceId: "default_low",
  modelId: "auto",
  language: "en-us",
  region: "us" as const,
};

function response(payload: unknown, status = 200): PalabraVoiceFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("Palabra voice catalog", () => {
  it("merges default, custom, and built-in voices without exposing auth", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl: PalabraVoiceFetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (url.includes("/builtin")) {
        return response({
          data: {
            items: [
              {
                voice_id: "builtin-1",
                name: "Calm narrator",
                description: "Neutral built-in voice",
                tts_sample: { text: { lang: "en" } },
              },
            ],
          },
        });
      }
      return response({
        data: {
          items: [
            {
              voice_id: "custom-1",
              name: "My cloned voice",
              lang_code: "en",
            },
          ],
        },
      });
    };

    const catalog = await listPalabraVoices({ config, fetchImpl });

    assert.deepEqual(
      catalog.voices.map((voice) => [voice.id, voice.category]),
      [
        ["default_low", "default"],
        ["default_high", "default"],
        ["custom-1", "custom"],
        ["builtin-1", "builtin"],
      ],
    );
    assert.equal(requests.length, 2);
    assert.equal(
      requests.every(
        (request) =>
          request.headers.Authorization === "Bearer secret-api-key" &&
          request.url.includes("provider=palabra"),
      ),
      true,
    );
    assert.equal(JSON.stringify(catalog).includes("secret-api-key"), false);
  });

  it("keeps usable voices when one catalog endpoint fails", async () => {
    const fetchImpl: PalabraVoiceFetch = async (url) =>
      url.includes("/builtin")
        ? response({}, 503)
        : response({
            data: { items: [{ voice_id: "custom-1", name: "Custom" }] },
          });

    const catalog = await listPalabraVoices({ config, fetchImpl });

    assert.equal(catalog.warningCode, "provider_unavailable");
    assert.equal(
      catalog.voices.some((voice) => voice.id === "custom-1"),
      true,
    );
    assert.equal(
      catalog.voices.some((voice) => voice.id === "default_high"),
      true,
    );
  });

  it("preserves an environment-configured voice absent from the catalog", async () => {
    const fetchImpl: PalabraVoiceFetch = async () =>
      response({ data: { items: [] } });

    const catalog = await listPalabraVoices({
      config: { ...config, voiceId: "custom-from-environment" },
      fetchImpl,
    });

    assert.deepEqual(catalog.voices.at(-1), {
      id: "custom-from-environment",
      name: "Configured voice",
      locale: "en-us",
      category: "configured",
    });
  });
});
