export const STT_IPC = {
  status: "stt:get-provider-status",
  start: "stt:start",
  audio: "stt:audio",
  finish: "stt:finish",
  cancel: "stt:cancel",
  event: "stt:event",
} as const;

/** AssemblyAI streaming accepts 8000 to 96000 Hz. We downsample to 16 kHz. */
export const STT_SAMPLE_RATE = 16_000;
export const MAX_STT_PHRASE_ID_LENGTH = 128;
/** One second of 16 kHz mono PCM16 is 32000 bytes. Frames are far smaller. */
export const MAX_STT_CHUNK_BYTES = 64_000;

export type SttProviderName = "assemblyai";

export type SttEnvVariableName =
  | "ASSEMBLYAI_API_KEY"
  | "ASSEMBLYAI_STREAMING_HOST"
  | "ASSEMBLYAI_FORMAT_TURNS";

export type SttProviderStatus = {
  configured: boolean;
  provider: SttProviderName | null;
  missing: SttEnvVariableName[];
};

export type SttBridgeErrorCode =
  | "provider_not_configured"
  | "provider_auth_error"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_request_error";

export type SttBridgeEvent =
  | {
      type: "partial";
      phraseId: string;
      revision: number;
      text: string;
    }
  | {
      type: "final";
      phraseId: string;
      text: string;
      receivedAt: number;
      confidence?: number;
    }
  | {
      type: "failed";
      phraseId: string;
      code: SttBridgeErrorCode;
    };

export type SttStartRequest = {
  phraseId: string;
  sampleRate: number;
};

export type SttAudioChunk = {
  phraseId: string;
  sequence: number;
  pcm: ArrayBuffer;
};

export type SttBridge = {
  getStatus: () => Promise<SttProviderStatus>;
  start: (request: SttStartRequest) => void;
  sendAudio: (chunk: SttAudioChunk) => void;
  finish: (phraseId: string) => void;
  cancel: (phraseId: string) => void;
  onEvent: (listener: (event: SttBridgeEvent) => void) => () => void;
};
