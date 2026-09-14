import type { TtsBridge, TtsVoiceSummary } from "../../shared/tts";
import { SYSTEM_DEFAULT_OUTPUT_ID } from "../audio/webAudioSink";
import type {
  NormalizedAudioFrame,
  StreamingAudioSink,
} from "../tts/contracts";
import { RemoteTtsAdapter } from "../tts/elevenLabsTtsAdapter";
import { FakeTtsAdapter } from "../tts/fakeTtsAdapter";
import { RelayRouteError, type RelayRoute } from "./correctedSpeechRelay";

export const RELAY_OUTPUT_STORAGE_KEY = "english-corrector.output-device";
export const RELAY_VOICE_STORAGE_KEY = "english-corrector.tts-voice";

type RelayStorage = {
  getItem(key: string): string | null;
};

export type RelayOutputDevice = {
  deviceId: string;
  kind: string;
  label: string;
};

export type RelayRouteResolverOptions = {
  bridge: TtsBridge | null;
  storage: RelayStorage;
  enumerateDevices?: () => Promise<readonly RelayOutputDevice[]>;
};

/** Browser-only sink for deterministic UI diagnostics without audible output. */
export class DiagnosticRelaySink implements StreamingAudioSink {
  async start(_outputDeviceId: string): Promise<void> {}

  async write(_frame: NormalizedAudioFrame): Promise<void> {}

  async drain(): Promise<void> {}

  async stop(): Promise<void> {}
}

async function outputLabel(
  outputDeviceId: string,
  enumerateDevices?: () => Promise<readonly RelayOutputDevice[]>,
): Promise<string> {
  if (!enumerateDevices) return "Saved virtual output";

  try {
    const devices = await enumerateDevices();
    const output = devices.find(
      (device) =>
        device.kind === "audiooutput" && device.deviceId === outputDeviceId,
    );
    return output?.label.trim() || "Saved virtual output";
  } catch {
    return "Saved virtual output";
  }
}

/** Resolves one immutable TTS voice and output route for the next phrase. */
export function createRelayRouteResolver(
  options: RelayRouteResolverOptions,
): () => Promise<RelayRoute> {
  return async () => {
    if (!options.bridge) {
      const adapter = new FakeTtsAdapter({ chunkDelayMs: 0 });
      const voice = adapter.listVoices()[0];
      if (!voice) throw new RelayRouteError("tts_voice_required");
      return {
        adapter,
        voiceId: voice.id,
        voiceLabel: voice.name,
        outputDeviceId: SYSTEM_DEFAULT_OUTPUT_ID,
        outputLabel: "Silent browser diagnostic",
      };
    }

    const outputDeviceId = options.storage
      .getItem(RELAY_OUTPUT_STORAGE_KEY)
      ?.trim();
    if (!outputDeviceId) {
      throw new RelayRouteError("output_device_required");
    }

    const status = await options.bridge.getStatus();
    if (!status.configured || !status.voiceId) {
      throw new RelayRouteError("provider_not_configured");
    }

    let catalog: TtsVoiceSummary[] = [];
    try {
      catalog = (await options.bridge.getVoices()).voices;
    } catch {
      // RemoteTtsAdapter falls back to the configured status voice.
    }

    const adapter = new RemoteTtsAdapter(options.bridge, status, catalog);
    const voices = adapter.listVoices();
    const savedVoiceId = options.storage
      .getItem(RELAY_VOICE_STORAGE_KEY)
      ?.trim();
    const voice =
      voices.find((item) => item.id === savedVoiceId) ??
      voices.find((item) => item.id === status.voiceId) ??
      voices[0];
    if (!voice) throw new RelayRouteError("tts_voice_required");

    return {
      adapter,
      voiceId: voice.id,
      voiceLabel: voice.name,
      outputDeviceId,
      outputLabel: await outputLabel(outputDeviceId, options.enumerateDevices),
    };
  };
}
