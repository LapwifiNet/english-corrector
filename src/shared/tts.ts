export const TTS_IPC = {
  status: "tts:get-provider-status",
  start: "tts:start",
  cancel: "tts:cancel",
  event: "tts:event",
} as const;

export type TtsProviderName = "palabra" | "elevenlabs";

export type TtsProviderEnvironmentVariable =
  "PALABRA_API_KEY" | "ELEVENLABS_API_KEY" | "ELEVENLABS_VOICE_ID";

export type TtsProviderStatus = {
  provider: TtsProviderName;
  configured: boolean;
  voiceId: string | null;
  modelId: string;
  outputFormat: "pcm_24000";
  missing: TtsProviderEnvironmentVariable[];
  language?: string;
  region?: "us" | "eu";
};

export type TtsBridgeRequest = {
  utteranceId: string;
  text: string;
  voiceId: string;
};

export type TtsBridgeEvent =
  | {
      type: "started";
      utteranceId: string;
      format: {
        sampleRate: 24_000;
        channels: 1;
        encoding: "pcm_s16le";
      };
    }
  | {
      type: "chunk";
      utteranceId: string;
      sequence: number;
      bytes: Uint8Array;
    }
  | {
      type: "completed";
      utteranceId: string;
    }
  | {
      type: "failed";
      utteranceId: string;
      code: string;
    };

export type TtsBridge = {
  getStatus: () => Promise<TtsProviderStatus>;
  start: (request: TtsBridgeRequest) => void;
  cancel: (utteranceId: string) => void;
  onEvent: (listener: (event: TtsBridgeEvent) => void) => () => void;
};
