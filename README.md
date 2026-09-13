# English Corrector

A macOS Intel-first prototype for a real-time English grammar-correcting virtual microphone.

## Current status

| Area                               | Status                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Epic 0: Audio routing spike        | Manually verified on macOS Intel with BlackHole 2ch                                                     |
| Epic 1: Text to virtual microphone | In progress: secure ElevenLabs streaming bridge implemented, manual natural-speech verification pending |
| Deterministic diagnostic adapter   | Implemented and manually verified through BlackHole                                                     |
| Speech-to-text and correction      | Not started                                                                                             |

The app now supports both a deterministic local diagnostic and natural ElevenLabs streaming. It automatically uses ElevenLabs when the required environment values are present at launch. Otherwise it keeps the offline diagnostic adapter active.

## What the app can do now

- Request macOS microphone permission through Electron.
- Discover physical input and output devices.
- Keep the known-good three-tone BlackHole routing fixture.
- Accept up to 280 characters of English text.
- Stream natural 24 kHz mono PCM from ElevenLabs through the Electron main process.
- Keep the ElevenLabs API key out of the renderer and logs.
- Fall back at startup to deterministic speech-like PCM when ElevenLabs is not configured.
- Reorder chunks, suppress duplicates, apply a bounded high-water buffer, and normalize audio to 48 kHz stereo Float32.
- Stream the result exactly once into the selected virtual output.
- Cancel the provider request, buffer, and playback with one action.
- Show first-chunk, first-audio, and total latency metrics.

The app never retries automatically after playback starts, preventing duplicate speech.

## Requirements

- macOS on Intel for the first supported target.
- Node.js 22 or newer.
- npm.
- [BlackHole 2ch](https://existential.audio/blackhole/) installed.
- An ElevenLabs API key and voice ID for natural speech testing.

## Install

```bash
git clone https://github.com/LapwifiNet/english-corrector.git
cd english-corrector
npm install
```

## Configure ElevenLabs

Set these values in the same terminal that will launch Electron:

```bash
export ELEVENLABS_API_KEY="your-api-key"
export ELEVENLABS_VOICE_ID="your-voice-id"
export ELEVENLABS_MODEL_ID="eleven_flash_v2_5"
```

`ELEVENLABS_MODEL_ID` is optional and defaults to `eleven_flash_v2_5`.

Do not commit the real values, place them in renderer code, or paste them into chat. The renderer receives only a safe provider status and the configured voice ID. All authenticated network requests run in the Electron main process.

If the API key or voice ID is missing, the app stays in deterministic diagnostic mode.

## Validate

Run the complete check:

```bash
npm run check
```

This runs Prettier validation, Node tests, TypeScript checks, and all Electron builds.

The deterministic suite currently contains 33 tests across 10 suites. It covers audio devices, fixture generation, streaming buffers, PCM normalization, fake synthesis, utterance orchestration, ElevenLabs HTTP streaming, safe configuration, IPC adapter behavior, and cancellation.

For sandbox or offline validation without the final TypeScript step:

```bash
npm run check:offline
```

## Run

```bash
npm run dev
```

Then:

1. Confirm the interface displays `ElevenLabs` instead of `Fake adapter`.
2. Grant microphone access.
3. Select the physical microphone.
4. Select `BlackHole 2ch` as the virtual output.
5. Enter an English sentence.
6. Click **Send to virtual mic**.
7. In Zoom, Meet, or Discord, choose `BlackHole 2ch` as the microphone.
8. Confirm that intelligible natural speech arrives once.
9. Start another run and click **Cancel** to verify that both the network request and playback stop cleanly.

You can still click **Play three tones** to retest the simpler Epic 0 route.

## Streaming design

The provider-neutral renderer contract remains:

```text
TtsAdapter.synthesize(request, signal)
  -> started(format)
  -> chunk(sequence, bytes)
  -> completed | failed(code)
```

The natural provider path is:

```text
Renderer ElevenLabs adapter
  -> narrow preload bridge
  -> Electron main-process HTTP stream
  -> ElevenLabs pcm_24000 bytes
  -> ordered chunk buffer
  -> PCM normalization to 48 kHz stereo
  -> Web Audio output sink
  -> selected BlackHole device
```

Important invariants:

- Every utterance has one immutable ID.
- The configured API key remains in the main process.
- Renderer input is validated again at the IPC boundary.
- Duplicate chunks are ignored.
- Missing sequences fail before playback finishes.
- A bounded high-water mark prevents unbounded buffering.
- Provider failures use stable internal error codes.
- Retrying is never automatic, preventing duplicate speech.
- Cancellation propagates through provider request, buffer, and output sink.

## Scripts

- `npm run dev`: build and run Electron.
- `npm run build`: build Electron main, preload, and renderer bundles.
- `npm test`: run deterministic unit and integration tests.
- `npm run typecheck`: typecheck Electron, renderer, and Node test targets.
- `npm run check`: run formatting, tests, typechecking, and build.
- `npm run check:offline`: run formatting, tests, and build.

## Next milestone

Manually verify intelligible ElevenLabs speech and cancellation through BlackHole on macOS Intel in Zoom, Google Meet, and Discord. Epic 1 is complete only after those tests pass.
