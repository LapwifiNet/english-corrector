/**
 * The microphone gives Float32 samples at the device rate, usually 48 kHz.
 * The provider wants raw little endian PCM16. These helpers are pure so the
 * conversion can be tested without audio hardware.
 */

export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(toRate) || toRate <= 0) return new Float32Array(0);
  if (fromRate === toRate) return samples;
  if (samples.length === 0) return new Float32Array(0);

  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[index] =
      (samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight;
  }

  return output;
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

export function encodePcmChunk(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): ArrayBuffer {
  const resampled = resampleLinear(samples, fromRate, toRate);
  return floatToPcm16(resampled).buffer as ArrayBuffer;
}
