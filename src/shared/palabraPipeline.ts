export const PALABRA_MESSAGE_TYPES = [
  "translated_transcription",
  "partial_translated_transcription",
  "partial_transcription",
  "validated_transcription",
] as const;

export const PALABRA_LANGUAGE_SUGGESTIONS = [
  "auto",
  "vi",
  "en",
  "en-us",
  "en-gb",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "pt-br",
  "ja",
  "ko",
  "zh",
  "ar",
  "hi",
  "id",
  "th",
] as const;

export const PALABRA_PIPELINE_STORAGE_KEY =
  "english-corrector.palabra-pipeline-v1";
export const PALABRA_DEFAULT_VOICE_ID = "572d2dc9-b645-42d7-bab6-bce50c70473d";
export const PALABRA_DEFAULT_TARGET_LANGUAGE = "en-gb";

export type PalabraMessageType = (typeof PALABRA_MESSAGE_TYPES)[number];
export type PalabraTransport = "webrtc" | "ws";
export type PalabraInputFormat = "opus" | "pcm_s16le" | "wav";
export type PalabraOutputFormat = "pcm_s16le" | "zlib_pcm_s16le";

export type PalabraInputSource = {
  type: PalabraTransport;
  format?: PalabraInputFormat;
  sample_rate?: number;
  channels?: 1 | 2;
};

export type PalabraOutputTarget = {
  type: PalabraTransport;
  format?: PalabraOutputFormat;
  sample_rate?: 24_000;
  channels?: 1;
};

export type PalabraSpeechGeneration = {
  voice_cloning: boolean;
  voice_id: string | null;
  voice_timbre_detection: {
    enabled: boolean;
    high_timbre_voices: string[];
    low_timbre_voices: string[];
  };
};

export type PalabraTranslationConfig = {
  target_language: string;
  allowed_source_languages: string[];
  translate_partial_transcriptions: boolean;
  speech_generation: PalabraSpeechGeneration;
};

export type PalabraPipelineConfig = {
  input_stream: {
    content_type: "audio";
    source: PalabraInputSource;
  };
  output_stream: {
    content_type: "audio";
    target: PalabraOutputTarget;
  };
  pipeline: {
    transcription: {
      source_language: string;
      detectable_languages: string[];
      segment_confirmation_silence_threshold: number;
      speakers_total: number | null;
      only_confirm_by_silence: boolean;
      sentence_splitter: {
        enabled: boolean;
      };
      verification: {
        auto_transcription_correction: boolean;
        transcription_correction_style: string | null;
      };
    };
    translations: PalabraTranslationConfig[];
    translation_queue_configs: {
      global: {
        desired_queue_level_ms: number;
        max_queue_level_ms: number;
        auto_tempo: boolean;
        auto_tempo_max_delay_ms: number;
        min_tempo: number;
        max_tempo: number;
      };
    };
    allowed_message_types: PalabraMessageType[];
  };
};

export type PalabraSetTaskMessage = {
  message_type: "set_task";
  data: PalabraPipelineConfig;
};

export const DEFAULT_PALABRA_PIPELINE_CONFIG: PalabraPipelineConfig = {
  input_stream: {
    content_type: "audio",
    source: {
      type: "webrtc",
    },
  },
  output_stream: {
    content_type: "audio",
    target: {
      type: "webrtc",
    },
  },
  pipeline: {
    transcription: {
      source_language: "vi",
      detectable_languages: [],
      segment_confirmation_silence_threshold: 0.7,
      speakers_total: null,
      only_confirm_by_silence: false,
      sentence_splitter: {
        enabled: true,
      },
      verification: {
        auto_transcription_correction: false,
        transcription_correction_style: null,
      },
    },
    translations: [
      {
        target_language: PALABRA_DEFAULT_TARGET_LANGUAGE,
        allowed_source_languages: [],
        translate_partial_transcriptions: true,
        speech_generation: {
          voice_cloning: false,
          voice_id: PALABRA_DEFAULT_VOICE_ID,
          voice_timbre_detection: {
            enabled: false,
            high_timbre_voices: ["default_high"],
            low_timbre_voices: ["default_low"],
          },
        },
      },
    ],
    translation_queue_configs: {
      global: {
        desired_queue_level_ms: 5_000,
        max_queue_level_ms: 20_000,
        auto_tempo: true,
        auto_tempo_max_delay_ms: 250,
        min_tempo: 1,
        max_tempo: 1.45,
      },
    },
    allowed_message_types: [...PALABRA_MESSAGE_TYPES],
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function languageCode(
  value: unknown,
  fallback: string,
  allowAuto: boolean,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (allowAuto && normalized === "auto") return normalized;
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized)
    ? normalized
    : fallback;
}

function voiceId(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : fallback;
}

function stringList(
  value: unknown,
  fallback: readonly string[] = [],
  allowAuto = false,
): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value
    .map((item) => languageCode(item, "", allowAuto))
    .filter(Boolean)
    .slice(0, 32);
  return [...new Set(items)];
}

function voiceList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value
    .map((item) => voiceId(item, null))
    .filter((item): item is string => Boolean(item))
    .slice(0, 1);
  return items.length ? items : [...fallback];
}

function inputFormat(value: unknown): PalabraInputFormat {
  return value === "opus" || value === "wav" ? value : "pcm_s16le";
}

function outputFormat(value: unknown): PalabraOutputFormat {
  return value === "zlib_pcm_s16le" ? value : "pcm_s16le";
}

function transport(value: unknown): PalabraTransport {
  return value === "ws" ? "ws" : "webrtc";
}

export function createDefaultPalabraTranslation(
  targetLanguage = "en-us",
): PalabraTranslationConfig {
  return {
    target_language: languageCode(targetLanguage, "en-us", false),
    allowed_source_languages: [],
    translate_partial_transcriptions: false,
    speech_generation: {
      voice_cloning: false,
      voice_id: "default_low",
      voice_timbre_detection: {
        enabled: false,
        high_timbre_voices: ["default_high"],
        low_timbre_voices: ["default_low"],
      },
    },
  };
}

export function clonePalabraPipelineConfig(
  config: PalabraPipelineConfig,
): PalabraPipelineConfig {
  return JSON.parse(JSON.stringify(config)) as PalabraPipelineConfig;
}

export function createDefaultPalabraPipelineConfig(): PalabraPipelineConfig {
  return clonePalabraPipelineConfig(DEFAULT_PALABRA_PIPELINE_CONFIG);
}

function normalizeTranslation(
  value: unknown,
  fallback: PalabraTranslationConfig,
): PalabraTranslationConfig {
  const root = asRecord(value);
  const speech = asRecord(root?.speech_generation);
  const timbre = asRecord(speech?.voice_timbre_detection);
  const voiceCloning = asBoolean(
    speech?.voice_cloning,
    fallback.speech_generation.voice_cloning,
  );
  const timbreEnabled =
    !voiceCloning &&
    asBoolean(
      timbre?.enabled,
      fallback.speech_generation.voice_timbre_detection.enabled,
    );
  const fixedVoice =
    voiceCloning || timbreEnabled
      ? null
      : voiceId(speech?.voice_id, fallback.speech_generation.voice_id);

  return {
    target_language: languageCode(
      root?.target_language,
      fallback.target_language,
      false,
    ),
    allowed_source_languages: stringList(
      root?.allowed_source_languages,
      fallback.allowed_source_languages,
    ),
    translate_partial_transcriptions: asBoolean(
      root?.translate_partial_transcriptions,
      fallback.translate_partial_transcriptions,
    ),
    speech_generation: {
      voice_cloning: voiceCloning,
      voice_id: fixedVoice,
      voice_timbre_detection: {
        enabled: timbreEnabled,
        high_timbre_voices: voiceList(
          timbre?.high_timbre_voices,
          fallback.speech_generation.voice_timbre_detection.high_timbre_voices,
        ),
        low_timbre_voices: voiceList(
          timbre?.low_timbre_voices,
          fallback.speech_generation.voice_timbre_detection.low_timbre_voices,
        ),
      },
    },
  };
}

export function normalizePalabraPipelineConfig(
  value: unknown,
): PalabraPipelineConfig {
  const fallback = DEFAULT_PALABRA_PIPELINE_CONFIG;
  const root = asRecord(value);
  const input = asRecord(root?.input_stream);
  const inputSource = asRecord(input?.source);
  const output = asRecord(root?.output_stream);
  const outputTarget = asRecord(output?.target);
  const pipeline = asRecord(root?.pipeline);
  const transcription = asRecord(pipeline?.transcription);
  const splitter = asRecord(transcription?.sentence_splitter);
  const verification = asRecord(transcription?.verification);
  const queueConfigs = asRecord(pipeline?.translation_queue_configs);
  const queue = asRecord(queueConfigs?.global);
  const selectedTransport = transport(inputSource?.type ?? outputTarget?.type);

  const source: PalabraInputSource =
    selectedTransport === "ws"
      ? {
          type: "ws",
          format: inputFormat(inputSource?.format),
          sample_rate: Math.round(
            clamp(asNumber(inputSource?.sample_rate, 24_000), 16_000, 48_000),
          ),
          channels: asNumber(inputSource?.channels, 1) === 2 ? 2 : 1,
        }
      : { type: "webrtc" };
  const target: PalabraOutputTarget =
    selectedTransport === "ws"
      ? {
          type: "ws",
          format: outputFormat(outputTarget?.format),
          sample_rate: 24_000,
          channels: 1,
        }
      : { type: "webrtc" };

  const fallbackTranslation = fallback.pipeline.translations[0]!;
  const rawTranslations = Array.isArray(pipeline?.translations)
    ? pipeline.translations.slice(0, 8)
    : [];
  const translations = rawTranslations.length
    ? rawTranslations.map((item, index) =>
        normalizeTranslation(
          item,
          index === 0 ? fallbackTranslation : createDefaultPalabraTranslation(),
        ),
      )
    : [clonePalabraPipelineConfig(fallback).pipeline.translations[0]!];

  let desiredQueue = Math.round(
    clamp(
      asNumber(
        queue?.desired_queue_level_ms,
        fallback.pipeline.translation_queue_configs.global
          .desired_queue_level_ms,
      ),
      2_000,
      163_840,
    ),
  );
  let maxQueue = Math.round(
    clamp(
      asNumber(
        queue?.max_queue_level_ms,
        fallback.pipeline.translation_queue_configs.global.max_queue_level_ms,
      ),
      3_000,
      163_840,
    ),
  );
  if (maxQueue <= desiredQueue) {
    if (desiredQueue >= 163_840) desiredQueue = 162_840;
    maxQueue = Math.min(163_840, desiredQueue + 1_000);
  }

  const minTempo = clamp(
    asNumber(
      queue?.min_tempo,
      fallback.pipeline.translation_queue_configs.global.min_tempo,
    ),
    1,
    2,
  );
  const maxTempo = Math.max(
    minTempo,
    clamp(
      asNumber(
        queue?.max_tempo,
        fallback.pipeline.translation_queue_configs.global.max_tempo,
      ),
      1,
      2,
    ),
  );

  const rawMessageTypes = pipeline?.allowed_message_types;
  const allowedMessageTypes = Array.isArray(rawMessageTypes)
    ? [
        ...new Set(
          rawMessageTypes.filter((item): item is PalabraMessageType =>
            PALABRA_MESSAGE_TYPES.includes(item as PalabraMessageType),
          ),
        ),
      ]
    : [...fallback.pipeline.allowed_message_types];

  const style = verification?.transcription_correction_style;
  const speakers = transcription?.speakers_total;

  return {
    input_stream: { content_type: "audio", source },
    output_stream: { content_type: "audio", target },
    pipeline: {
      transcription: {
        source_language: languageCode(
          transcription?.source_language,
          fallback.pipeline.transcription.source_language,
          true,
        ),
        detectable_languages: stringList(
          transcription?.detectable_languages,
          fallback.pipeline.transcription.detectable_languages,
        ),
        segment_confirmation_silence_threshold: clamp(
          asNumber(
            transcription?.segment_confirmation_silence_threshold,
            fallback.pipeline.transcription
              .segment_confirmation_silence_threshold,
          ),
          0.3,
          2,
        ),
        speakers_total:
          speakers === null || speakers === "" || speakers === undefined
            ? null
            : Math.round(clamp(asNumber(speakers, 1), 1, 1_000)),
        only_confirm_by_silence: asBoolean(
          transcription?.only_confirm_by_silence,
          fallback.pipeline.transcription.only_confirm_by_silence,
        ),
        sentence_splitter: {
          enabled: asBoolean(
            splitter?.enabled,
            fallback.pipeline.transcription.sentence_splitter.enabled,
          ),
        },
        verification: {
          auto_transcription_correction: asBoolean(
            verification?.auto_transcription_correction,
            fallback.pipeline.transcription.verification
              .auto_transcription_correction,
          ),
          transcription_correction_style:
            typeof style === "string" && style.trim()
              ? style.trim().slice(0, 120)
              : null,
        },
      },
      translations,
      translation_queue_configs: {
        global: {
          desired_queue_level_ms: desiredQueue,
          max_queue_level_ms: maxQueue,
          auto_tempo: asBoolean(
            queue?.auto_tempo,
            fallback.pipeline.translation_queue_configs.global.auto_tempo,
          ),
          auto_tempo_max_delay_ms: Math.round(
            clamp(
              asNumber(
                queue?.auto_tempo_max_delay_ms,
                fallback.pipeline.translation_queue_configs.global
                  .auto_tempo_max_delay_ms,
              ),
              60,
              10_000,
            ),
          ),
          min_tempo: minTempo,
          max_tempo: maxTempo,
        },
      },
      allowed_message_types: allowedMessageTypes,
    },
  };
}

export function parseStoredPalabraPipelineConfig(
  serialized: string | null,
): PalabraPipelineConfig {
  if (!serialized) return createDefaultPalabraPipelineConfig();
  try {
    return normalizePalabraPipelineConfig(JSON.parse(serialized));
  } catch {
    return createDefaultPalabraPipelineConfig();
  }
}

export function setPrimaryPalabraVoice(
  config: PalabraPipelineConfig,
  nextVoiceId: string,
): PalabraPipelineConfig {
  const next = clonePalabraPipelineConfig(config);
  const primary = next.pipeline.translations[0];
  if (!primary) return normalizePalabraPipelineConfig(next);

  primary.speech_generation.voice_cloning = false;
  primary.speech_generation.voice_timbre_detection.enabled = false;
  primary.speech_generation.voice_id = nextVoiceId;
  return normalizePalabraPipelineConfig(next);
}

export function buildPalabraSetTaskMessage(
  config: PalabraPipelineConfig,
): PalabraSetTaskMessage {
  return {
    message_type: "set_task",
    data: normalizePalabraPipelineConfig(config),
  };
}
