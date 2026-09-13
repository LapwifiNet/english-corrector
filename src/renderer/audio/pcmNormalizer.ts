import type { AudioFormat, NormalizedAudioFrame } from "../tts/contracts";

const TARGET_SAMPLE_RATE = 48_000 as const;

type DecodedChannels = [Float32Array] | [Float32Array, Float32Array];

export class PcmFormatError extends Error {
  readonly code = "unsupported_audio_format";

  constructor(message: string) {
    super(message);
    this.name = "PcmFormatError";
  }
}

function bytesPerSample(format: AudioFormat): number {
  return format.encoding === "pcm_s16le" ? 2 : 4;
}

function validateFormat(format: AudioFormat): void {
  if (
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 96_000
  ) {
    throw new PcmFormatError(`Unsupported sample rate: ${format.sampleRate}.`);
  }

  if (format.channels !== 1 && format.channels !== 2) {
    throw new PcmFormatError(`Unsupported channel count: ${format.channels}.`);
  }
}

function decodePcm(bytes: Uint8Array, format: AudioFormat): DecodedChannels {
  const sampleBytes = bytesPerSample(format);
  const frameBytes = sampleBytes * format.channels;

  if (bytes.byteLength % frameBytes !== 0) {
    throw new PcmFormatError("PCM bytes do not end on a complete audio frame.");
  }

  const frameCount = bytes.byteLength / frameBytes;
  const channels = Array.from(
    { length: format.channels },
    () => new Float32Array(frameCount),
  ) as DecodedChannels;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = (frame * format.channels + channel) * sampleBytes;
      const sample =
        format.encoding === "pcm_s16le"
          ? view.getInt16(offset, true) / 32_768
          : view.getFloat32(offset, true);
      channels[channel]![frame] = Math.max(-1, Math.min(1, sample));
    }
  }

  return channels;
}

function resample(
  channel: Float32Array,
  inputSampleRate: number,
): Float32Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return channel.slice();
  if (channel.length === 0) return new Float32Array();

  const outputLength = Math.max(
    1,
    Math.round((channel.length * TARGET_SAMPLE_RATE) / inputSampleRate),
  );
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = (index * inputSampleRate) / TARGET_SAMPLE_RATE;
    const leftIndex = Math.min(Math.floor(sourcePosition), channel.length - 1);
    const rightIndex = Math.min(leftIndex + 1, channel.length - 1);
    const mix = sourcePosition - leftIndex;
    output[index] =
      channel[leftIndex]! * (1 - mix) + channel[rightIndex]! * mix;
  }

  return output;
}

export class PcmStreamNormalizer {
  private remainder = new Uint8Array();

  constructor(readonly inputFormat: AudioFormat) {
    validateFormat(inputFormat);
  }

  push(bytes: Uint8Array): NormalizedAudioFrame | null {
    const combined = new Uint8Array(
      this.remainder.byteLength + bytes.byteLength,
    );
    combined.set(this.remainder, 0);
    combined.set(bytes, this.remainder.byteLength);

    const frameBytes =
      bytesPerSample(this.inputFormat) * this.inputFormat.channels;
    const completeByteLength =
      Math.floor(combined.byteLength / frameBytes) * frameBytes;
    this.remainder = combined.slice(completeByteLength);

    if (completeByteLength === 0) return null;

    const decoded = decodePcm(
      combined.subarray(0, completeByteLength),
      this.inputFormat,
    );
    const left = resample(decoded[0], this.inputFormat.sampleRate);
    const right =
      this.inputFormat.channels === 1
        ? left.slice()
        : resample(decoded[1]!, this.inputFormat.sampleRate);

    return {
      sampleRate: TARGET_SAMPLE_RATE,
      channels: [left, right],
      frameCount: left.length,
      durationSeconds: left.length / TARGET_SAMPLE_RATE,
    };
  }

  finish(): void {
    if (this.remainder.byteLength > 0) {
      throw new PcmFormatError(
        "Streaming PCM ended with an incomplete audio frame.",
      );
    }
  }
}
