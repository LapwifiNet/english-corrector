import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PALABRA_DEFAULT_TARGET_LANGUAGE,
  PALABRA_DEFAULT_VOICE_ID,
  buildPalabraSetTaskMessage,
  createDefaultPalabraPipelineConfig,
  normalizePalabraPipelineConfig,
  parseStoredPalabraPipelineConfig,
  setPrimaryPalabraVoice,
} from "../shared/palabraPipeline";

describe("Palabra pipeline settings", () => {
  it("uses the requested WebRTC Vietnamese to English UK profile by default", () => {
    const config = createDefaultPalabraPipelineConfig();
    const transcription = config.pipeline.transcription;
    const translation = config.pipeline.translations[0]!;
    const queue = config.pipeline.translation_queue_configs.global;

    assert.equal(config.input_stream.source.type, "webrtc");
    assert.equal(config.output_stream.target.type, "webrtc");
    assert.equal(transcription.source_language, "vi");
    assert.equal(transcription.segment_confirmation_silence_threshold, 0.7);
    assert.equal(transcription.sentence_splitter.enabled, true);
    assert.equal(
      transcription.verification.auto_transcription_correction,
      false,
    );
    assert.equal(translation.target_language, PALABRA_DEFAULT_TARGET_LANGUAGE);
    assert.equal(translation.translate_partial_transcriptions, true);
    assert.equal(
      translation.speech_generation.voice_id,
      PALABRA_DEFAULT_VOICE_ID,
    );
    assert.equal(queue.desired_queue_level_ms, 5_000);
    assert.equal(queue.max_queue_level_ms, 20_000);
    assert.equal(queue.min_tempo, 1);
    assert.equal(queue.max_tempo, 1.45);
  });

  it("normalizes persisted settings to Palabra transport and range rules", () => {
    const config = normalizePalabraPipelineConfig({
      input_stream: {
        source: {
          type: "ws",
          format: "unsupported",
          sample_rate: 99_000,
          channels: 2,
        },
      },
      output_stream: {
        target: { type: "webrtc", format: "zlib_pcm_s16le" },
      },
      pipeline: {
        transcription: {
          source_language: "VI",
          segment_confirmation_silence_threshold: 9,
          speakers_total: 2_000,
        },
        translations: [
          {
            target_language: "EN-GB",
            translate_partial_transcriptions: true,
            speech_generation: {
              voice_cloning: true,
              voice_id: "ignored-voice",
              voice_timbre_detection: { enabled: true },
            },
          },
        ],
        translation_queue_configs: {
          global: {
            desired_queue_level_ms: 9_000,
            max_queue_level_ms: 4_000,
            min_tempo: 2,
            max_tempo: 1,
            auto_tempo_max_delay_ms: 20_000,
          },
        },
        allowed_message_types: [
          "partial_transcription",
          "partial_transcription",
          "not-supported",
        ],
      },
    });

    assert.deepEqual(config.input_stream.source, {
      type: "ws",
      format: "pcm_s16le",
      sample_rate: 48_000,
      channels: 2,
    });
    assert.deepEqual(config.output_stream.target, {
      type: "ws",
      format: "zlib_pcm_s16le",
      sample_rate: 24_000,
      channels: 1,
    });
    assert.equal(config.pipeline.transcription.source_language, "vi");
    assert.equal(
      config.pipeline.transcription.segment_confirmation_silence_threshold,
      2,
    );
    assert.equal(config.pipeline.transcription.speakers_total, 1_000);
    assert.equal(
      config.pipeline.translations[0]?.speech_generation.voice_id,
      null,
    );
    assert.equal(
      config.pipeline.translations[0]?.speech_generation.voice_timbre_detection
        .enabled,
      false,
    );
    assert.equal(
      config.pipeline.translation_queue_configs.global.max_queue_level_ms,
      10_000,
    );
    assert.equal(config.pipeline.translation_queue_configs.global.max_tempo, 2);
    assert.equal(
      config.pipeline.translation_queue_configs.global.auto_tempo_max_delay_ms,
      10_000,
    );
    assert.deepEqual(config.pipeline.allowed_message_types, [
      "partial_transcription",
    ]);
  });

  it("restores defaults from invalid local storage and builds set_task", () => {
    const config = parseStoredPalabraPipelineConfig("{bad-json");
    const message = buildPalabraSetTaskMessage(config);

    assert.equal(message.message_type, "set_task");
    assert.equal(message.data.pipeline.transcription.source_language, "vi");
    assert.equal(
      message.data.pipeline.translations[0]?.target_language,
      "en-gb",
    );
  });

  it("keeps the menu and current TTS voice synchronized", () => {
    const config = setPrimaryPalabraVoice(
      createDefaultPalabraPipelineConfig(),
      "custom-voice-2",
    );
    const speech = config.pipeline.translations[0]!.speech_generation;

    assert.equal(speech.voice_id, "custom-voice-2");
    assert.equal(speech.voice_cloning, false);
    assert.equal(speech.voice_timbre_detection.enabled, false);
  });
});
