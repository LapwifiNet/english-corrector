# Call app setup

Status: source-checked beta checklist. Real calls still need validation on the supported macOS Intel release candidate.

Last source check: 2026-09-15.

## Choose a guide

- [Zoom](./zoom.md)
- [Google Meet](./google-meet.md)
- [Discord](./discord.md)

## Intended signal path

```text
Physical microphone
  -> English Corrector capture and correction
  -> selected TTS voice
  -> BlackHole 2ch output
  -> call app microphone input

Call app speaker output
  -> physical headphones or speakers
```

BlackHole is the call app microphone, not the call app speaker. Prefer headphones during setup to prevent the physical microphone from hearing the call output.

## Prepare English Corrector

1. Install and connect BlackHole 2ch before opening the call app.
2. Open English Corrector and finish the privacy and microphone steps.
3. Confirm the virtual output banner reports `BlackHole 2ch` as ready.
4. In **Audio setup**, select the real physical microphone.
5. In **Audio setup**, select `BlackHole 2ch` as **Virtual output**.
6. In **Microphone to corrected speech**, select the same physical microphone.
7. Select the intended TTS voice.
8. Write down the physical microphone name so it can be restored after the call.

English Corrector does not change the macOS default output and does not silently replace a missing BlackHole device with physical speakers.

## Shared route test

Run this test before joining an important call:

1. Open the target call app and follow its guide from this directory.
2. Set the call app microphone or input to `BlackHole 2ch`.
3. Keep the call app speaker or output on physical headphones or speakers.
4. Start the call app microphone test.
5. In English Corrector, click **Play three tones**.
6. Confirm that the call app receives the three tones once.
7. Hold **Space** or **Hold to talk**, speak one short sentence, then release.
8. Confirm that the call app receives the corrected voice once.
9. Start another phrase and click **Cancel phrase** while it is active.
10. Confirm that no remaining audio plays after cancellation.

## Pass criteria

- The call app receives the three tones.
- A corrected phrase arrives exactly once.
- The original physical microphone is not sent directly to the call app.
- Call audio remains audible through physical headphones or speakers.
- Cancellation leaves no delayed or duplicate playback.
- Removing BlackHole blocks the relay instead of selecting another output.

## Return to the physical microphone

Do this whenever English Corrector is no longer needed:

1. Stop any active phrase or route test in English Corrector.
2. In the call app, change the microphone or input from `BlackHole 2ch` back to the recorded physical microphone.
3. Speak and confirm that the call app input meter responds.
4. Keep the call app speaker or output on the intended physical device.
5. Leave the meeting or voice channel, then close English Corrector.

Do not assume that leaving a meeting resets its saved microphone. Verify the input again before the next call.

## Shared troubleshooting

| Symptom                                                              | Safe action                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| BlackHole is absent in English Corrector                             | Reconnect or reinstall it, then use **Check audio outputs**. Restart the call app if it was already open. |
| English Corrector reports `Completed` but the call app meter is idle | Re-select `BlackHole 2ch` as the call app microphone. Do not change the speaker to BlackHole.             |
| The call has echo or feedback                                        | Use headphones and confirm the call app speaker is a physical device.                                     |
| A phrase arrives twice                                               | Stop the test, confirm only one English Corrector instance is running, and retry one phrase.              |
| The physical microphone disappears                                   | Stop the hold, reconnect the microphone, refresh devices, and select it again.                            |
| BlackHole is removed during a phrase                                 | Cancel the phrase. Reconnect BlackHole and complete the readiness check before retrying.                  |

## Source record

The navigation and test labels below were checked against official help pages on 2026-09-15:

- Zoom: [Testing your audio settings for Zoom meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062765)
- Google Meet: [Connect your video and audio](https://support.google.com/meet/answer/10409699?hl=en)
- Discord: [Mic Testing](https://support.discord.com/hc/en-us/articles/360020641332-Mic-Testing)
- Discord: [Voice and Video Troubleshooting Guide](https://support.discord.com/hc/en-us/articles/360045138471-Discord-Voice-and-Video-Troubleshooting-Guide)

These sources document each app's normal microphone controls. They do not certify English Corrector or BlackHole. Treat the route as unverified until the release matrix is run on macOS Intel.
