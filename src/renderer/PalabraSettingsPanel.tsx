import { useState } from "react";
import {
  PALABRA_LANGUAGE_SUGGESTIONS,
  PALABRA_MESSAGE_TYPES,
  buildPalabraSetTaskMessage,
  clonePalabraPipelineConfig,
  createDefaultPalabraPipelineConfig,
  createDefaultPalabraTranslation,
  normalizePalabraPipelineConfig,
  type PalabraInputFormat,
  type PalabraMessageType,
  type PalabraOutputFormat,
  type PalabraPipelineConfig,
  type PalabraTransport,
} from "../shared/palabraPipeline";
import type { TtsVoice } from "./tts/contracts";

type PalabraSettingsPanelProps = {
  config: PalabraPipelineConfig;
  voices: readonly TtsVoice[];
  disabled: boolean;
  onChange: (config: PalabraPipelineConfig) => void;
};

type VoiceMode = "fixed" | "clone" | "timbre";

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function formatList(value: readonly string[]): string {
  return value.join(", ");
}

function numericValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function voiceLabel(voice: TtsVoice): string {
  const category = voice.category ? ` · ${voice.category}` : "";
  return `${voice.name}${category}`;
}

export function PalabraSettingsPanel({
  config,
  voices,
  disabled,
  onChange,
}: PalabraSettingsPanelProps) {
  const [copyLabel, setCopyLabel] = useState("Copy JSON");
  const transcription = config.pipeline.transcription;
  const queue = config.pipeline.translation_queue_configs.global;
  const transport = config.input_stream.source.type;
  const targets = config.pipeline.translations
    .map((translation) => translation.target_language.toUpperCase())
    .join(", ");

  const update = (mutate: (next: PalabraPipelineConfig) => void) => {
    const next = clonePalabraPipelineConfig(config);
    mutate(next);
    onChange(normalizePalabraPipelineConfig(next));
  };

  const updateTransport = (nextTransport: PalabraTransport) => {
    update((next) => {
      next.input_stream.source =
        nextTransport === "ws"
          ? {
              type: "ws",
              format: "pcm_s16le",
              sample_rate: 24_000,
              channels: 1,
            }
          : { type: "webrtc" };
      next.output_stream.target =
        nextTransport === "ws"
          ? {
              type: "ws",
              format: "pcm_s16le",
              sample_rate: 24_000,
              channels: 1,
            }
          : { type: "webrtc" };
    });
  };

  const updateTranslation = (
    index: number,
    mutate: (
      next: PalabraPipelineConfig["pipeline"]["translations"][number],
    ) => void,
  ) => {
    update((next) => {
      const translation = next.pipeline.translations[index];
      if (translation) mutate(translation);
    });
  };

  const copyJson = async () => {
    const json = JSON.stringify(buildPalabraSetTaskMessage(config), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopyLabel("Copied");
    } catch {
      setCopyLabel("Copy unavailable");
    }
    window.setTimeout(() => setCopyLabel("Copy JSON"), 1_600);
  };

  return (
    <section className="config-menu" aria-labelledby="palabra-config-heading">
      <details>
        <summary>
          <span>
            <small>04 · PALABRA PIPELINE</small>
            <strong id="palabra-config-heading">Translation settings</strong>
          </span>
          <span className="config-summary">
            {transcription.source_language.toUpperCase()} → {targets} ·{" "}
            {transport}
          </span>
        </summary>

        <div className="config-menu-body">
          <div className="config-intro">
            <div>
              <h3>Default pipeline profile</h3>
              <p>
                Saved locally. The first target voice also controls the current
                text-to-speech preview and virtual microphone output. The other
                values generate the set_task profile for speech-to-speech mode.
              </p>
            </div>
            <div className="config-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={disabled}
                onClick={() => onChange(createDefaultPalabraPipelineConfig())}
              >
                Reset default
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void copyJson()}
              >
                {copyLabel}
              </button>
            </div>
          </div>

          <fieldset disabled={disabled}>
            <legend>Stream transport</legend>
            <div className="config-grid three-columns">
              <label>
                <span>Content type</span>
                <select value="audio" disabled>
                  <option value="audio">Audio</option>
                </select>
                <small>Palabra currently supports audio only.</small>
              </label>
              <label>
                <span>Input and output transport</span>
                <select
                  value={transport}
                  onChange={(event) =>
                    updateTransport(event.target.value as PalabraTransport)
                  }
                >
                  <option value="webrtc">WebRTC</option>
                  <option value="ws">WebSocket</option>
                </select>
                <small>Input and output transports must match.</small>
              </label>
              <div className="config-readout">
                <span>Output content</span>
                <strong>Audio</strong>
                <small>Translated speech output.</small>
              </div>
            </div>

            {transport === "ws" && (
              <div className="config-grid ws-grid">
                <label>
                  <span>Input format</span>
                  <select
                    value={config.input_stream.source.format ?? "pcm_s16le"}
                    onChange={(event) =>
                      update((next) => {
                        next.input_stream.source.format = event.target
                          .value as PalabraInputFormat;
                      })
                    }
                  >
                    <option value="opus">Opus</option>
                    <option value="pcm_s16le">PCM S16LE</option>
                    <option value="wav">WAV</option>
                  </select>
                </label>
                <label>
                  <span>Input sample rate</span>
                  <input
                    key={config.input_stream.source.sample_rate}
                    type="number"
                    min="16000"
                    max="48000"
                    step="1000"
                    defaultValue={
                      config.input_stream.source.sample_rate ?? 24_000
                    }
                    onBlur={(event) =>
                      update((next) => {
                        next.input_stream.source.sample_rate = numericValue(
                          event.target.value,
                          24_000,
                        );
                      })
                    }
                  />
                </label>
                <label>
                  <span>Input channels</span>
                  <select
                    value={config.input_stream.source.channels ?? 1}
                    onChange={(event) =>
                      update((next) => {
                        next.input_stream.source.channels =
                          event.target.value === "2" ? 2 : 1;
                      })
                    }
                  >
                    <option value="1">Mono</option>
                    <option value="2">Stereo</option>
                  </select>
                </label>
                <label>
                  <span>Output format</span>
                  <select
                    value={config.output_stream.target.format ?? "pcm_s16le"}
                    onChange={(event) =>
                      update((next) => {
                        next.output_stream.target.format = event.target
                          .value as PalabraOutputFormat;
                      })
                    }
                  >
                    <option value="pcm_s16le">PCM S16LE</option>
                    <option value="zlib_pcm_s16le">Zlib PCM S16LE</option>
                  </select>
                </label>
                <div className="config-readout">
                  <span>Output sample rate</span>
                  <strong>24,000 Hz</strong>
                </div>
                <div className="config-readout">
                  <span>Output channels</span>
                  <strong>Mono</strong>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset disabled={disabled}>
            <legend>Transcription</legend>
            <div className="config-grid three-columns">
              <label>
                <span>Source language</span>
                <input
                  key={transcription.source_language}
                  list="palabra-language-codes"
                  defaultValue={transcription.source_language}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.transcription.source_language =
                        event.target.value;
                    })
                  }
                />
                <small>Use auto to enable language detection.</small>
              </label>
              <label>
                <span>Detectable languages</span>
                <input
                  key={formatList(transcription.detectable_languages)}
                  type="text"
                  placeholder="vi, en, fr"
                  defaultValue={formatList(transcription.detectable_languages)}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.transcription.detectable_languages =
                        parseList(event.target.value);
                    })
                  }
                />
                <small>Comma separated. Used only with source auto.</small>
              </label>
              <label>
                <span>Silence threshold</span>
                <input
                  key={transcription.segment_confirmation_silence_threshold}
                  type="number"
                  min="0.3"
                  max="2"
                  step="0.1"
                  defaultValue={
                    transcription.segment_confirmation_silence_threshold
                  }
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.transcription.segment_confirmation_silence_threshold =
                        numericValue(event.target.value, 0.7);
                    })
                  }
                />
                <small>0.3 to 2.0 seconds.</small>
              </label>
              <label>
                <span>Expected speakers</span>
                <input
                  key={transcription.speakers_total ?? "automatic"}
                  type="number"
                  min="1"
                  max="1000"
                  placeholder="Automatic"
                  defaultValue={transcription.speakers_total ?? ""}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.transcription.speakers_total = event.target
                        .value
                        ? numericValue(event.target.value, 1)
                        : null;
                    })
                  }
                />
                <small>Optional, from 1 to 1,000.</small>
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={transcription.only_confirm_by_silence}
                  onChange={(event) =>
                    update((next) => {
                      next.pipeline.transcription.only_confirm_by_silence =
                        event.target.checked;
                    })
                  }
                />
                <span>Confirm segments only by silence</span>
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={transcription.sentence_splitter.enabled}
                  onChange={(event) =>
                    update((next) => {
                      next.pipeline.transcription.sentence_splitter.enabled =
                        event.target.checked;
                    })
                  }
                />
                <span>Enable sentence splitter</span>
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={
                    transcription.verification.auto_transcription_correction
                  }
                  onChange={(event) =>
                    update((next) => {
                      next.pipeline.transcription.verification.auto_transcription_correction =
                        event.target.checked;
                    })
                  }
                />
                <span>Auto transcription correction</span>
                <small>Palabra marks this option as work in progress.</small>
              </label>
              <label className="span-two">
                <span>Correction style</span>
                <input
                  type="text"
                  maxLength={120}
                  placeholder="No style"
                  disabled={
                    !transcription.verification.auto_transcription_correction
                  }
                  value={
                    transcription.verification.transcription_correction_style ??
                    ""
                  }
                  onChange={(event) =>
                    update((next) => {
                      next.pipeline.transcription.verification.transcription_correction_style =
                        event.target.value || null;
                    })
                  }
                />
              </label>
            </div>
          </fieldset>

          <fieldset disabled={disabled}>
            <legend>Translations and voices</legend>
            <div className="translation-list">
              {config.pipeline.translations.map((translation, index) => {
                const speech = translation.speech_generation;
                const voiceMode: VoiceMode = speech.voice_cloning
                  ? "clone"
                  : speech.voice_timbre_detection.enabled
                    ? "timbre"
                    : "fixed";
                const currentVoiceIds = [
                  speech.voice_id,
                  speech.voice_timbre_detection.high_timbre_voices[0],
                  speech.voice_timbre_detection.low_timbre_voices[0],
                ].filter((value): value is string => Boolean(value));
                const missingVoiceIds = [
                  ...new Set(
                    currentVoiceIds.filter(
                      (id) => !voices.some((voice) => voice.id === id),
                    ),
                  ),
                ];

                return (
                  <article
                    className="translation-card"
                    key={`${index}-${translation.target_language}`}
                  >
                    <div className="translation-heading">
                      <strong>Target {index + 1}</strong>
                      {config.pipeline.translations.length > 1 && (
                        <button
                          type="button"
                          className="text-button danger-text"
                          onClick={() =>
                            update((next) => {
                              next.pipeline.translations.splice(index, 1);
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="config-grid three-columns">
                      <label>
                        <span>Target language</span>
                        <input
                          key={translation.target_language}
                          list="palabra-language-codes"
                          defaultValue={translation.target_language}
                          onBlur={(event) =>
                            updateTranslation(index, (next) => {
                              next.target_language = event.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Allowed source languages</span>
                        <input
                          key={formatList(translation.allowed_source_languages)}
                          type="text"
                          placeholder="vi, en"
                          defaultValue={formatList(
                            translation.allowed_source_languages,
                          )}
                          onBlur={(event) =>
                            updateTranslation(index, (next) => {
                              next.allowed_source_languages = parseList(
                                event.target.value,
                              );
                            })
                          }
                        />
                        <small>Optional for conditional translation.</small>
                      </label>
                      <label className="toggle-field compact-toggle">
                        <input
                          type="checkbox"
                          checked={translation.translate_partial_transcriptions}
                          onChange={(event) =>
                            updateTranslation(index, (next) => {
                              next.translate_partial_transcriptions =
                                event.target.checked;
                            })
                          }
                        />
                        <span>Translate partial transcriptions</span>
                      </label>
                      <label>
                        <span>Voice mode</span>
                        <select
                          value={voiceMode}
                          onChange={(event) =>
                            updateTranslation(index, (next) => {
                              const mode = event.target.value as VoiceMode;
                              next.speech_generation.voice_cloning =
                                mode === "clone";
                              next.speech_generation.voice_timbre_detection.enabled =
                                mode === "timbre";
                              if (mode !== "fixed") {
                                next.speech_generation.voice_id = null;
                              } else if (!next.speech_generation.voice_id) {
                                next.speech_generation.voice_id =
                                  voices[0]?.id ?? "default_low";
                              }
                            })
                          }
                        >
                          <option value="fixed">Fixed voice</option>
                          <option value="clone">Voice cloning</option>
                          <option value="timbre">Timbre detection</option>
                        </select>
                      </label>
                      <label className="span-two">
                        <span>Voice ID</span>
                        <select
                          value={speech.voice_id ?? ""}
                          disabled={voiceMode !== "fixed"}
                          onChange={(event) =>
                            updateTranslation(index, (next) => {
                              next.speech_generation.voice_id =
                                event.target.value || null;
                            })
                          }
                        >
                          <option value="">No fixed voice</option>
                          {voices.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voiceLabel(voice)}
                            </option>
                          ))}
                          {missingVoiceIds.map((id) => (
                            <option key={id} value={id}>
                              {id} · configured
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>High timbre voice</span>
                        <select
                          value={
                            speech.voice_timbre_detection
                              .high_timbre_voices[0] ?? "default_high"
                          }
                          disabled={voiceMode !== "timbre"}
                          onChange={(event) =>
                            updateTranslation(index, (next) => {
                              next.speech_generation.voice_timbre_detection.high_timbre_voices =
                                [event.target.value];
                            })
                          }
                        >
                          {voices.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voiceLabel(voice)}
                            </option>
                          ))}
                          {missingVoiceIds.map((id) => (
                            <option key={id} value={id}>
                              {id} · configured
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Low timbre voice</span>
                        <select
                          value={
                            speech.voice_timbre_detection
                              .low_timbre_voices[0] ?? "default_low"
                          }
                          disabled={voiceMode !== "timbre"}
                          onChange={(event) =>
                            updateTranslation(index, (next) => {
                              next.speech_generation.voice_timbre_detection.low_timbre_voices =
                                [event.target.value];
                            })
                          }
                        >
                          {voices.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voiceLabel(voice)}
                            </option>
                          ))}
                          {missingVoiceIds.map((id) => (
                            <option key={id} value={id}>
                              {id} · configured
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </article>
                );
              })}
            </div>
            <button
              type="button"
              className="secondary-button compact-button add-target-button"
              onClick={() =>
                update((next) => {
                  next.pipeline.translations.push(
                    createDefaultPalabraTranslation(),
                  );
                })
              }
            >
              Add target language
            </button>
          </fieldset>

          <fieldset disabled={disabled}>
            <legend>Translation queue</legend>
            <div className="config-grid three-columns">
              <label>
                <span>Desired queue</span>
                <input
                  key={queue.desired_queue_level_ms}
                  type="number"
                  min="2000"
                  max="163840"
                  step="100"
                  defaultValue={queue.desired_queue_level_ms}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.desired_queue_level_ms =
                        numericValue(event.target.value, 5_000);
                    })
                  }
                />
                <small>2,000 to 163,840 ms.</small>
              </label>
              <label>
                <span>Maximum queue</span>
                <input
                  key={queue.max_queue_level_ms}
                  type="number"
                  min="3000"
                  max="163840"
                  step="100"
                  defaultValue={queue.max_queue_level_ms}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.max_queue_level_ms =
                        numericValue(event.target.value, 20_000);
                    })
                  }
                />
                <small>Must be greater than desired queue.</small>
              </label>
              <label>
                <span>Auto tempo delay</span>
                <input
                  key={queue.auto_tempo_max_delay_ms}
                  type="number"
                  min="60"
                  max="10000"
                  step="10"
                  defaultValue={queue.auto_tempo_max_delay_ms}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.auto_tempo_max_delay_ms =
                        numericValue(event.target.value, 250);
                    })
                  }
                />
                <small>60 to 10,000 ms.</small>
              </label>
              <label className="toggle-field compact-toggle">
                <input
                  type="checkbox"
                  checked={queue.auto_tempo}
                  onChange={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.auto_tempo =
                        event.target.checked;
                    })
                  }
                />
                <span>Enable automatic tempo</span>
              </label>
              <label>
                <span>Minimum tempo</span>
                <input
                  key={queue.min_tempo}
                  type="number"
                  min="1"
                  max="2"
                  step="0.05"
                  defaultValue={queue.min_tempo}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.min_tempo =
                        numericValue(event.target.value, 1);
                    })
                  }
                />
              </label>
              <label>
                <span>Maximum tempo</span>
                <input
                  key={queue.max_tempo}
                  type="number"
                  min="1"
                  max="2"
                  step="0.05"
                  defaultValue={queue.max_tempo}
                  onBlur={(event) =>
                    update((next) => {
                      next.pipeline.translation_queue_configs.global.max_tempo =
                        numericValue(event.target.value, 1.45);
                    })
                  }
                />
              </label>
            </div>
          </fieldset>

          <fieldset disabled={disabled}>
            <legend>Received message types</legend>
            <div className="message-type-grid">
              {PALABRA_MESSAGE_TYPES.map((messageType) => (
                <label
                  className="toggle-field compact-toggle"
                  key={messageType}
                >
                  <input
                    type="checkbox"
                    checked={config.pipeline.allowed_message_types.includes(
                      messageType,
                    )}
                    onChange={(event) =>
                      update((next) => {
                        const selected = new Set(
                          next.pipeline.allowed_message_types,
                        );
                        if (event.target.checked) selected.add(messageType);
                        else selected.delete(messageType);
                        next.pipeline.allowed_message_types = [
                          ...selected,
                        ] as PalabraMessageType[];
                      })
                    }
                  />
                  <span>{messageType}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <details className="config-json">
            <summary>Generated set_task JSON</summary>
            <pre>
              {JSON.stringify(buildPalabraSetTaskMessage(config), null, 2)}
            </pre>
          </details>
        </div>
      </details>

      <datalist id="palabra-language-codes">
        {PALABRA_LANGUAGE_SUGGESTIONS.map((language) => (
          <option key={language} value={language} />
        ))}
      </datalist>
    </section>
  );
}
