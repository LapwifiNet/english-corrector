import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  TtsBridge,
  TtsProviderStatus,
  TtsVoiceCatalog,
} from "../../shared/tts";
import { SYSTEM_DEFAULT_OUTPUT_ID } from "../audio/webAudioSink";
import { RelayRouteError } from "./correctedSpeechRelay";
import {
  DiagnosticRelaySink,
  RELAY_OUTPUT_STORAGE_KEY,
  RELAY_VOICE_STORAGE_KEY,
  createRelayRouteResolver,
} from "./relayRoute";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  constructor(values: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}

function providerStatus(
  overrides: Partial<TtsProviderStatus> = {},
): TtsProviderStatus {
  return {
    provider: "palabra",
    configured: true,
    voiceId: "voice-default",
    modelId: "palabra-realtime",
    outputFormat: "pcm_24000",
    missing: [],
    language: "en-gb",
    region: "us",
    ...overrides,
  };
}

function voiceCatalog(): TtsVoiceCatalog {
  return {
    provider: "palabra",
    voices: [
      {
        id: "voice-default",
        name: "Default voice",
        locale: "en-GB",
        category: "configured",
      },
      {
        id: "voice-custom",
        name: "Custom voice",
        locale: "en-GB",
        category: "custom",
      },
    ],
  };
}

function ttsBridge(
  options: {
    status?: TtsProviderStatus;
    catalog?: TtsVoiceCatalog;
    catalogError?: boolean;
  } = {},
): TtsBridge {
  return {
    getStatus: async () => options.status ?? providerStatus(),
    getVoices: async () => {
      if (options.catalogError) throw new Error("catalog unavailable");
      return options.catalog ?? voiceCatalog();
    },
    start: () => undefined,
    cancel: () => undefined,
    onEvent: () => () => undefined,
  };
}

function hasRouteCode(code: string) {
  return (error: unknown) =>
    error instanceof RelayRouteError && error.code === code;
}

describe("createRelayRouteResolver", () => {
  it("uses silent deterministic audio in a browser diagnostic", async () => {
    const resolveRoute = createRelayRouteResolver({
      bridge: null,
      storage: new MemoryStorage(),
    });

    const route = await resolveRoute();

    assert.equal(route.adapter.provider, "diagnostic-fake");
    assert.equal(route.voiceId, "diagnostic-pcm");
    assert.equal(route.outputDeviceId, SYSTEM_DEFAULT_OUTPUT_ID);
    assert.equal(route.outputLabel, "Silent browser diagnostic");

    const sink = new DiagnosticRelaySink();
    await sink.start(route.outputDeviceId);
    await sink.drain();
    await sink.stop();
  });

  it("requires a saved virtual output before loading provider status", async () => {
    let statusCalls = 0;
    const bridge = ttsBridge();
    bridge.getStatus = async () => {
      statusCalls += 1;
      return providerStatus();
    };
    const resolveRoute = createRelayRouteResolver({
      bridge,
      storage: new MemoryStorage(),
    });

    await assert.rejects(
      () => resolveRoute(),
      hasRouteCode("output_device_required"),
    );
    assert.equal(statusCalls, 0);
  });

  it("rejects an unconfigured production provider", async () => {
    const resolveRoute = createRelayRouteResolver({
      bridge: ttsBridge({
        status: providerStatus({
          configured: false,
          voiceId: null,
          missing: ["PALABRA_API_KEY"],
        }),
      }),
      storage: new MemoryStorage({
        [RELAY_OUTPUT_STORAGE_KEY]: "blackhole-2ch",
      }),
    });

    await assert.rejects(
      () => resolveRoute(),
      hasRouteCode("provider_not_configured"),
    );
  });

  it("resolves the saved voice and readable output label", async () => {
    const resolveRoute = createRelayRouteResolver({
      bridge: ttsBridge(),
      storage: new MemoryStorage({
        [RELAY_OUTPUT_STORAGE_KEY]: "blackhole-2ch",
        [RELAY_VOICE_STORAGE_KEY]: "voice-custom",
      }),
      enumerateDevices: async () => [
        {
          deviceId: "blackhole-2ch",
          kind: "audiooutput",
          label: "BlackHole 2ch",
        },
      ],
    });

    const route = await resolveRoute();

    assert.equal(route.adapter.provider, "palabra");
    assert.equal(route.voiceId, "voice-custom");
    assert.equal(route.voiceLabel, "Custom voice");
    assert.equal(route.outputDeviceId, "blackhole-2ch");
    assert.equal(route.outputLabel, "BlackHole 2ch");
  });

  it("falls back to the configured voice when catalog loading fails", async () => {
    const resolveRoute = createRelayRouteResolver({
      bridge: ttsBridge({ catalogError: true }),
      storage: new MemoryStorage({
        [RELAY_OUTPUT_STORAGE_KEY]: "blackhole-2ch",
        [RELAY_VOICE_STORAGE_KEY]: "stale-voice",
      }),
    });

    const route = await resolveRoute();

    assert.equal(route.voiceId, "voice-default");
    assert.match(route.voiceLabel ?? "", /Palabra/);
    assert.equal(route.outputLabel, "Saved virtual output");
  });
});
