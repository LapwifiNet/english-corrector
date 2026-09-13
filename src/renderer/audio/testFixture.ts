const SAMPLE_RATE = 48_000;
const SEGMENTS = [
  { frequency: 440, seconds: 0.22 },
  { frequency: 0, seconds: 0.12 },
  { frequency: 554.37, seconds: 0.22 },
  { frequency: 0, seconds: 0.12 },
  { frequency: 659.25, seconds: 0.32 },
];

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function createThreeToneWavBlob(): Blob {
  const sampleCount = SEGMENTS.reduce(
    (total, segment) => total + Math.floor(segment.seconds * SAMPLE_RATE),
    0,
  );
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let sampleOffset = 44;
  for (const segment of SEGMENTS) {
    const frameCount = Math.floor(segment.seconds * SAMPLE_RATE);
    const fadeFrames = Math.floor(SAMPLE_RATE * 0.01);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const fade = Math.min(
        1,
        frame / Math.max(1, fadeFrames),
        (frameCount - frame - 1) / Math.max(1, fadeFrames),
      );
      const sample =
        segment.frequency === 0
          ? 0
          : Math.round(
              0.28 *
                32_767 *
                Math.max(0, fade) *
                Math.sin(
                  (2 * Math.PI * segment.frequency * frame) / SAMPLE_RATE,
                ),
            );

      view.setInt16(sampleOffset, sample, true);
      sampleOffset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}
