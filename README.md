# English Corrector

A macOS Intel-first prototype for a real-time English grammar-correcting virtual microphone.

## Current status

| Area | Status |
| --- | --- |
| Epic 0: Audio routing spike | Manually verified on macOS Intel with BlackHole 2ch |
| Epic 1: Text to virtual microphone | In progress: deterministic streaming PCM diagnostic is implemented |
| Natural streaming TTS provider | Not integrated yet |
| Speech-to-text and correction | Not started |

The current Epic 1 slice proves the provider-neutral streaming path before any paid or networked TTS provider is connected.

## What the app can do now

- Request macOS microphone permission through Electron.
- Discover physical input and output devices.
- Keep the known-good three-tone BlackHole routing fixture.
- Accept up to 280 characters of English text.
- Convert that text into deterministic speech-like PCM chunks through a fake TTS adapter.
- Reorder chunks, suppress duplicates, apply a bounded high-water buffer, and normalize audio to 48 kHz stereo Float32.
- Stream the result exactly once into the selected virtual output.
- Cancel synthesis, buffering, and playback with one action.
- Show first-chunk, first-audio, and total latency metrics.

> The fake adapter does not produce intelligible natural speech. It exists to make ordering, buffering, playback, error, and cancellation behavior reproducible. A production streaming TTS adapter is the next milestone.

## Requirements

- macOS on Intel for the first supported target.
- Node.js 20 or newer.
- npm.
- [BlackHole 2ch](https://existential.audio/blackhole/) installed.

## Install

```bash
git clone https://github.com/LapwifiNet/english-corrector.git
cd english-corrector
npm install
```

## Validate

Run the complete check:

```bash
npm run check
```

This runs Prettier validation, Node tests, TypeScript checks, and all Electron builds.

The deterministic suite currently contains 25 tests across the audio-device, test-fixture, streaming-buffer, PCM-normalization, fake-provider, and utterance-runner layers.

For sandbox or offline validation without the final TypeScript step:

```bash
npm run check:offline
```

## Run

```bash
npm run dev
```

Then:

1. Grant microphone access.
2. Select the physical microphone.
3. Select `BlackHole 2ch` as the virtual output.
4. Enter an English sentence.
5. Click **Send to virtual mic**.
6. In Zoom, Meet, or Discord, choose `BlackHole 2ch` as the microphone.
7. Confirm that the deterministic diagnostic sequence arrives once.
8. Start another run and click **Cancel** to verify that playback stops cleanly.

You can still click **Play three tones** to retest the simpler Epic 0 route.

## Streaming design

The UI depends on a stable adapter contract rather than a provider SDK:

```text
TtsAdapter.stream(request, signal)
  -> meta
  -> chunk(sequence, payload)
  -> done
```

The renderer then applies:

```text
ordered chunk buffer
  -> PCM decode
  -> resample to 48 kHz
  -> duplicate mono to stereo
  -> Web Audio output sink
  -> selected BlackHole device
```

Important invariants:

- Every utterance has one immutable ID.
- Duplicate chunks are ignored.
- Missing sequences fail before playback finishes.
- A bounded high-water mark prevents unbounded buffering.
- Provider failures use stable internal error codes.
- Retrying is never automatic, preventing duplicate speech.
- Cancellation propagates through provider request, buffer, and output sink.

## Scripts

- `npm run dev`: run renderer watch mode and Electron.
- `npm run build`: build Electron main, preload, and renderer bundles.
- `npm test`: run deterministic unit and integration tests.
- `npm run typecheck`: typecheck Electron, renderer, and Node test targets.
- `npm run check`: run formatting, tests, typechecking, and build.
- `npm run check:offline`: run formatting, tests, and build.

## Next milestone

Add a real streaming TTS provider behind the existing `TtsAdapter`, normalize the provider's stream into the same internal format, then manually verify intelligible speech through BlackHole on macOS Intel. Epic 1 is not complete until that manual test passes.
