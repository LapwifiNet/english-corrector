import type {
  AudioFormat,
  TtsAdapter,
  TtsEvent,
  TtsVoice,
  UtteranceRequest,
} from "./contracts";

const SAMPLE_RATE = 24_000;
const FORMAT: AudioFormat = {
  sampleRate: SAMPLE_RATE,
  channels: 1,
  encoding: "pcm_s16le",
};
const VOICES: readonly TtsVoice[] = [
  {
    id: "diagnostic-pcm",
    name: "Diagnostic PCM",
    locale: "en-US",
    diagnostic: true,
  },
];

export type FakeTtsOptions = {
  chunkBytes?: number;
  chunkDelayMs?: number;
  failAtSequence?: number;
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  if (milliseconds <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function frameCountFor(character: string): number {
  if (/\s/.test(character)) return Math.floor(SAMPLE_RATE * 0.025);
  if (/[.,!?;:]/.test(character)) return Math.floor(SAMPLE_RATE * 0.045);
  return Math.floor(SAMPLE_RATE * 0.055);
}

export function synthesizeDiagnosticPcm(text: string): Uint8Array {
  const normalized = text.trim().slice(0, 280);
  const leadFrames = Math.floor(SAMPLE_RATE * 0.06);
  const trailFrames = Math.floor(SAMPLE_RATE * 0.09);
  const characterFrames = [...normalized].map(frameCountFor);
  const totalFrames =
    leadFrames +
    characterFrames.reduce((total, frames) => total + frames, 0) +
    trailFrames;
  const bytes = new Uint8Array(totalFrames * 2);
  const view = new DataView(bytes.buffer);
  const fadeFrames = Math.floor(SAMPLE_RATE * 0.006);
  let outputFrame = leadFrames;

  [...normalized].forEach((character, characterIndex) => {
    const frames = characterFrames[characterIndex] ?? 0;
    const code = character.toLowerCase().charCodeAt(0) || 0;
    const frequency = 145 + (code % 24) * 16;
    const silence = /\s|[.,!?;:]/.test(character);

    for (let frame = 0; frame < frames; frame += 1) {
      const envelope = Math.max(
        0,
        Math.min(
          1,
          frame / Math.max(1, fadeFrames),
          (frames - frame - 1) / Math.max(1, fadeFrames),
        ),
      );
      const time = frame / SAMPLE_RATE;
      const wave =
        Math.sin(2 * Math.PI * frequency * time) +
        0.32 * Math.sin(2 * Math.PI * frequency * 2 * time) +
        0.14 * Math.sin(2 * Math.PI * frequency * 3 * time);
      const sample = silence ? 0 : Math.round(32_767 * 0.16 * envelope * wave);

      view.setInt16(outputFrame * 2, sample, true);
      outputFrame += 1;
    }
  });

  return bytes;
}

export class FakeTtsAdapter implements TtsAdapter {
  readonly provider = "diagnostic-fake";
  private readonly chunkBytes: number;
  private readonly chunkDelayMs: number;
  private readonly failAtSequence?: number;

  constructor(options: FakeTtsOptions = {}) {
    const requestedChunkBytes = Math.max(2, options.chunkBytes ?? 4_096);
    this.chunkBytes = requestedChunkBytes - (requestedChunkBytes % 2);
    this.chunkDelayMs = Math.max(0, options.chunkDelayMs ?? 18);
    this.failAtSequence = options.failAtSequence;
  }

  listVoices(): readonly TtsVoice[] {
    return VOICES;
  }

  async *synthesize(
    request: UtteranceRequest,
    signal: AbortSignal,
  ): AsyncIterable<TtsEvent> {
    assertNotAborted(signal);
    const text = request.text.trim();

    if (!text) {
      yield {
        type: "failed",
        utteranceId: request.utteranceId,
        code: "empty_text",
      };
      return;
    }

    yield {
      type: "started",
      utteranceId: request.utteranceId,
      format: FORMAT,
    };

    const audio = synthesizeDiagnosticPcm(text);
    let sequence = 0;

    for (let offset = 0; offset < audio.byteLength; offset += this.chunkBytes) {
      await wait(this.chunkDelayMs, signal);
      assertNotAborted(signal);

      if (sequence === this.failAtSequence) {
        yield {
          type: "failed",
          utteranceId: request.utteranceId,
          code: "diagnostic_failure",
        };
        return;
      }

      yield {
        type: "chunk",
        utteranceId: request.utteranceId,
        sequence,
        bytes: audio.slice(offset, offset + this.chunkBytes),
      };
      sequence += 1;
    }

    assertNotAborted(signal);
    yield { type: "completed", utteranceId: request.utteranceId };
  }
}
