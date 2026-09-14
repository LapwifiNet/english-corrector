import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readPreferredTtsProviderStatus,
  readPreferredTtsRuntimeConfig,
} from "./ttsProvider";

describe("TTS provider priority", () => {
  it("selects Palabra first when both providers are configured", () => {
    const environment = {
      PALABRA_API_KEY: "palabra-key",
      ELEVENLABS_API_KEY: "elevenlabs-key",
      ELEVENLABS_VOICE_ID: "elevenlabs-voice",
    };

    assert.equal(
      readPreferredTtsProviderStatus(environment).provider,
      "palabra",
    );
    assert.equal(
      readPreferredTtsRuntimeConfig(environment)?.provider,
      "palabra",
    );
  });

  it("uses ElevenLabs as the second provider", () => {
    const environment = {
      ELEVENLABS_API_KEY: "elevenlabs-key",
      ELEVENLABS_VOICE_ID: "elevenlabs-voice",
    };

    assert.equal(
      readPreferredTtsProviderStatus(environment).provider,
      "elevenlabs",
    );
    assert.equal(
      readPreferredTtsRuntimeConfig(environment)?.provider,
      "elevenlabs",
    );
  });

  it("reports Palabra setup when no natural provider is configured", () => {
    const status = readPreferredTtsProviderStatus({});

    assert.equal(status.provider, "palabra");
    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, ["PALABRA_API_KEY"]);
    assert.equal(readPreferredTtsRuntimeConfig({}), null);
  });
});
