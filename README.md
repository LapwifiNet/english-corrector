# English Corrector

A macOS Intel-first prototype for a real-time English grammar-correcting virtual microphone.

## Current status

| Area                               | Status                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Epic 0: Audio routing spike        | Manually verified on macOS Intel with BlackHole 2ch                                            |
| Epic 1: Text to virtual microphone | In progress: Palabra is the primary streaming provider, with ElevenLabs as the second provider |
| Deterministic diagnostic adapter   | Implemented and manually verified through BlackHole                                            |
| Speech-to-text and correction      | Not started                                                                                    |

The app now supports Palabra, ElevenLabs, and a deterministic offline diagnostic. Provider priority is fixed and explicit:

1. Palabra when `PALABRA_API_KEY` is configured.
2. ElevenLabs when Palabra is unavailable and the ElevenLabs values are configured.
3. The deterministic fake adapter when no natural provider is configured.

A provider failure during an utterance never triggers an automatic fallback or retry, preventing duplicate speech.

## What the app can do now

- Request macOS microphone permission through Electron.
- Discover physical input and output devices.
- Keep the known-good three-tone BlackHole routing fixture.
- Accept up to 280 characters of English text.
- Keep one persistent Palabra WebSocket session across utterances.
- Load up to 100 built-in and 100 custom Palabra voices through the main process.
- Persist the selected voice locally and apply it per sentence without reconnecting.
- Preview the selected voice on the Mac default output.
- Send incremental text and receive base64-encoded 24 kHz mono PCM chunks from Palabra.
- Use ElevenLabs HTTP streaming as the second natural provider.
- Keep all provider API keys out of the renderer and logs.
- Reorder chunks, suppress duplicates, apply a bounded high-water buffer, and normalize audio to 48 kHz stereo Float32.
- Stream the result exactly once into the selected virtual output.
- Cancel the provider request, buffer, and playback with one action.
- Show first-chunk, first-audio, and total latency metrics.

## Requirements

- macOS on Intel for the first supported target.
- Node.js 22 or newer.
- npm.
- [BlackHole 2ch](https://existential.audio/blackhole/) installed.
- A Palabra API key for the primary natural-speech path.
- Optionally, an ElevenLabs API key and voice ID for fallback at startup.

## Install

```bash
git clone https://github.com/LapwifiNet/english-corrector.git
cd english-corrector
npm install
```

## Configure Palabra as the primary provider

Set the API key in the same terminal that will launch Electron:

```bash
export PALABRA_API_KEY="your-api-key"
```

Optional Palabra settings:

```bash
export PALABRA_VOICE_ID="default_low"
export PALABRA_MODEL_ID="auto"
export PALABRA_LANGUAGE="en-us"
export PALABRA_REGION="us"
```

Defaults:

- Voice: `default_low`
- Model: `auto`
- Language: `en-us`
- Region: `us`
- Audio: raw 16-bit little-endian PCM, 24 kHz, mono

Use `PALABRA_REGION="eu"` to select the European WebSocket endpoint.

## Select and preview Palabra voices

When Palabra is configured, the app securely loads both voice catalogs at startup:

- `GET /saas/voice/builtin` for Palabra built-in voices.
- `GET /saas/voice` for custom cloned voices.

The API key stays in the Electron main process. The renderer receives only safe voice metadata such as ID, name, locale, category, and description.

Choose a voice from the **Voice** menu, then click **Preview voice**. The preview uses a fixed sentence and plays on the Mac default output instead of BlackHole. The selected voice is saved in local storage and sent as a per-message Palabra `voice_options.voice_id` override. This preserves the existing WebSocket session.

`PALABRA_VOICE_ID` remains the startup fallback. If a catalog request fails, the app keeps `default_low`, `default_high`, and the configured voice available. Restart the app after creating a new custom voice in the Palabra portal so it reloads the catalog.

## Optional ElevenLabs fallback

If Palabra is not configured, the app can use ElevenLabs:

```bash
export ELEVENLABS_API_KEY="your-api-key"
export ELEVENLABS_VOICE_ID="your-voice-id"
export ELEVENLABS_MODEL_ID="eleven_flash_v2_5"
```

`ELEVENLABS_MODEL_ID` is optional and defaults to `eleven_flash_v2_5`.

Do not commit real credentials, place them in renderer code, or paste them into chat. Authenticated requests run only in the Electron main process. The renderer receives a safe provider status, voice metadata, and PCM events.

## Validate

Run the complete check:

```bash
npm run check
```

This runs Prettier validation, Node tests, TypeScript checks, and all Electron builds.

The deterministic suite currently contains 46 tests across 13 suites. It covers audio devices, fixture generation, streaming buffers, PCM normalization, fake synthesis, utterance orchestration, Palabra WebSocket lifecycle, secure built-in and custom voice listing, per-sentence voice overrides, provider priority, ElevenLabs HTTP streaming, safe configuration, IPC adapter behavior, and cancellation.

For sandbox or offline validation without the final TypeScript step:

```bash
npm run check:offline
```

## Run

```bash
npm run dev
```

Then:

1. Confirm the interface displays `Palabra` instead of `ElevenLabs` or `Fake adapter`.
2. Grant microphone access.
3. Select the physical microphone.
4. Select `BlackHole 2ch` as the virtual output.
5. Select a built-in or custom Palabra voice.
6. Click **Preview voice** and confirm it plays on the Mac default output.
7. Enter an English sentence.
8. Click **Send to virtual mic**.
9. In Zoom, Meet, or Discord, choose `BlackHole 2ch` as the microphone.
10. Confirm that intelligible natural speech arrives once with the selected voice.
11. Change the voice, send another sentence, and confirm that the initialized WebSocket session is reused.
12. Start another run and click **Cancel** to verify that the WebSocket generation and playback stop cleanly.

You can still click **Play three tones** to retest the simpler Epic 0 route.

## Streaming design

The provider-neutral renderer contract remains:

```text
TtsAdapter.synthesize(request, signal)
  -> started(format)
  -> chunk(sequence, bytes)
  -> completed | failed(code)
```

The primary provider path is:

```text
Renderer remote TTS adapter
  -> narrow preload bridge
  -> Electron main-process persistent WebSocket
  -> Palabra pcm 24 kHz mono chunks
  -> ordered chunk buffer
  -> PCM normalization to 48 kHz stereo
  -> Web Audio output sink
  -> selected BlackHole device
```

Important invariants:

- Palabra has higher startup priority than ElevenLabs.
- Every utterance has one immutable ID, reused as the Palabra generation ID.
- Provider API keys remain in the main process.
- Renderer input is validated again at the IPC boundary.
- The Palabra WebSocket is initialized once and reused across utterances.
- Voice catalog requests are authenticated only in the main process.
- Every Palabra text message includes the selected voice override.
- Voice preview uses the same streaming and cancellation contract.
- Duplicate chunks are ignored.
- Missing sequences fail before playback finishes.
- A bounded high-water mark prevents unbounded buffering.
- Provider failures use stable internal error codes.
- Retrying and provider switching are never automatic during an utterance.
- Cancellation propagates through provider request, buffer, and output sink.

## Scripts

- `npm run dev`: build and run Electron.
- `npm run build`: build Electron main, preload, and renderer bundles.
- `npm test`: run deterministic unit and integration tests.
- `npm run typecheck`: typecheck Electron, renderer, and Node test targets.
- `npm run check`: run formatting, tests, typechecking, and build.
- `npm run check:offline`: run formatting, tests, and build.

## Next milestone

Manually verify voice listing, preview playback, selected-voice speech, WebSocket reuse, and cancellation on macOS Intel. Then verify the selected voice through BlackHole in Zoom, Google Meet, and Discord. Epic 1 is complete only after those tests pass.
