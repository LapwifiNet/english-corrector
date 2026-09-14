/**
 * Hands-free mode needs a local answer to one question: is someone speaking
 * right now. The provider still decides where a sentence ends, so this only
 * has to be steady enough to know when to open a session, when to let an
 * unused one go, and when the microphone is hearing our own playback.
 */
export type VoiceActivityOptions = {
  /** Level that opens speech. Kept above the stop level to avoid chatter. */
  startThreshold?: number;
  /** Level below which a frame counts as silence. */
  stopThreshold?: number;
  /** Sound shorter than this stays a click instead of becoming speech. */
  minSpeechMs?: number;
  /** Silence tolerated inside one breath before speech closes. */
  hangoverMs?: number;
};

export const DEFAULT_VOICE_ACTIVITY: Required<VoiceActivityOptions> = {
  startThreshold: 0.02,
  stopThreshold: 0.01,
  minSpeechMs: 120,
  hangoverMs: 600,
};

export type VoiceActivityStatus = {
  speaking: boolean;
  rms: number;
  /** Timestamp of the last frame that carried voice, null when never. */
  lastVoiceAt: number | null;
};

export type VoiceActivityDetector = {
  push: (samples: Float32Array, at: number) => VoiceActivityStatus;
  status: () => VoiceActivityStatus;
  reset: () => void;
};

export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let total = 0;
  for (const sample of samples) total += sample * sample;

  return Math.sqrt(total / samples.length);
}

export function createVoiceActivityDetector(
  options: VoiceActivityOptions = {},
): VoiceActivityDetector {
  const settings = { ...DEFAULT_VOICE_ACTIVITY, ...options };

  let speaking = false;
  let rms = 0;
  let lastVoiceAt: number | null = null;
  let candidateSince: number | null = null;

  const snapshot = (): VoiceActivityStatus => ({ speaking, rms, lastVoiceAt });

  return {
    push: (samples, at) => {
      rms = frameRms(samples);

      if (speaking) {
        if (rms >= settings.stopThreshold) {
          lastVoiceAt = at;
        } else if (
          lastVoiceAt !== null &&
          at - lastVoiceAt >= settings.hangoverMs
        ) {
          speaking = false;
          candidateSince = null;
        }

        return snapshot();
      }

      if (rms < settings.startThreshold) {
        candidateSince = null;
        return snapshot();
      }

      candidateSince ??= at;
      if (at - candidateSince >= settings.minSpeechMs) {
        speaking = true;
        lastVoiceAt = at;
        candidateSince = null;
      }

      return snapshot();
    },
    status: snapshot,
    reset: () => {
      speaking = false;
      rms = 0;
      lastVoiceAt = null;
      candidateSince = null;
    },
  };
}
