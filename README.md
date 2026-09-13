# English Corrector

A near real-time English grammar-correcting virtual microphone for online meetings.

The first target is macOS on Intel. The initial milestone proves that an Electron app can route deterministic audio into BlackHole 2ch so Zoom, Google Meet, or Discord can receive it as a microphone.

## Current scope

This repository currently contains the Epic 0 desktop shell:

- Electron main process with context isolation and sandboxing
- React and TypeScript renderer
- macOS microphone permission bridge
- Audio input and output device discovery
- Explicit physical input and virtual output selection
- Deterministic in-memory WAV fixture with three tones
- Selected-output playback with Stop and cleanup
- Feedback-loop warning based on audio device groups
- Node test runner coverage for device rules and the WAV fixture

STT, grammar correction, TTS, voice cloning, and direct microphone passthrough are intentionally not included yet.

## Signal path

```text
Physical microphone
  -> English Corrector
  -> Speech-to-text
  -> Constrained correction
  -> Text-to-speech
  -> BlackHole 2ch
  -> Zoom / Google Meet / Discord
```

Epic 0 only implements device setup and fixture playback. Raw microphone audio is not routed to the meeting app.

## Requirements

- macOS Intel for the first hardware validation
- Node.js 22 or newer
- BlackHole 2ch
- Headphones for call testing

## Development

```bash
npm install
npm run dev
```

Quality gate:

```bash
npm run check
```

The quality gate checks formatting, TypeScript, unit tests, Electron compilation, and the renderer production build.

## Manual Epic 0 checkpoint

1. Install BlackHole 2ch.
2. Run the desktop app.
3. Grant microphone access.
4. Select the physical microphone as input.
5. Select BlackHole 2ch as output.
6. Select BlackHole 2ch as the microphone in the meeting app.
7. Play the three-tone fixture.
8. Confirm that the meeting app receives exactly one fixture playback.
9. Stop the test and confirm that no buffered audio remains.

## Privacy defaults

- Raw microphone passthrough is off.
- The generated fixture stays on the local Mac.
- The app does not store raw audio or transcripts.
- No provider credentials are present in the renderer.

## Status

The renderer and domain logic are validated with offline tooling. A fresh dependency install, Electron launch, and actual BlackHole routing still require verification on the declared macOS Intel test machine.
