export type UtteranceId = string;

export type AudioFormat = {
  sampleRate: number;
  channels: 1 | 2;
  encoding: "pcm_s16le" | "pcm_f32le";
};

export type TtsEvent =
  | {
      type: "started";
      utteranceId: UtteranceId;
      format: AudioFormat;
    }
  | {
      type: "chunk";
      utteranceId: UtteranceId;
      sequence: number;
      bytes: Uint8Array;
    }
  | {
      type: "completed";
      utteranceId: UtteranceId;
    }
  | {
      type: "failed";
      utteranceId: UtteranceId;
      code: string;
    };

export type TtsVoice = {
  id: string;
  name: string;
  locale: string;
  diagnostic?: boolean;
};

export type UtteranceRequest = {
  utteranceId: UtteranceId;
  text: string;
  voiceId: string;
};

export interface TtsAdapter {
  readonly provider: string;
  listVoices(): readonly TtsVoice[];
  synthesize(
    request: UtteranceRequest,
    signal: AbortSignal,
  ): AsyncIterable<TtsEvent>;
}

export type NormalizedAudioFrame = {
  sampleRate: 48_000;
  channels: [Float32Array, Float32Array];
  frameCount: number;
  durationSeconds: number;
};

export interface StreamingAudioSink {
  start(outputDeviceId: string): Promise<void>;
  write(frame: NormalizedAudioFrame): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export type UtteranceStage =
  | "idle"
  | "synthesizing"
  | "buffering"
  | "playing"
  | "completed"
  | "cancelled"
  | "failed";

export type UtteranceMetrics = {
  requestStartedAt: number;
  firstChunkAt?: number;
  ttsCompletedAt?: number;
  playbackStartedAt?: number;
  playbackCompletedAt?: number;
  duplicateChunks: number;
  outOfOrderChunks: number;
};

export type PipelineSnapshot = {
  stage: UtteranceStage;
  bufferedBytes: number;
  metrics: UtteranceMetrics;
  errorCode?: string;
};

export type UtteranceResult = {
  stage: "completed" | "cancelled" | "failed";
  metrics: UtteranceMetrics;
  errorCode?: string;
};

export function createUtteranceId(): UtteranceId {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  return `utterance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
