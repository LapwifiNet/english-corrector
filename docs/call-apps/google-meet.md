# Google Meet setup

Status: source-checked beta checklist. A real Google Meet call with BlackHole still needs macOS Intel validation.

Start with the [shared preparation and route test](./README.md).

## Configure before joining

1. Open English Corrector first and confirm `BlackHole 2ch` is ready.
2. Open the meeting in a supported desktop browser.
3. In the preview tile, open the microphone device menu.
4. Select `BlackHole 2ch` as the microphone.
5. Select physical headphones or speakers as the speaker. Do not select BlackHole as the speaker.
6. If the device menu is not visible, open **More options > Settings > Audio** and make the same selections.
7. Keep English Corrector open while Meet uses the virtual input.

## Test the microphone

1. In the pre-join self-check, select the microphone control and start its audio check.
2. Click **Play three tones** in English Corrector.
3. Confirm the Meet microphone bar moves while the tones play.
4. Run the corrected speech step from the shared route test.
5. Confirm the microphone bar moves for the corrected phrase.
6. Click **Speaker > Test speakers** and confirm the sound comes from the intended physical output.
7. Join only after both checks pass.

Google Meet's official self-check confirms microphone activity. Use a controlled call with another participant for the first end-to-end listening test.

## Change the route during a meeting

1. Select the arrow next to the microphone icon.
2. Choose `BlackHole 2ch` as the microphone.
3. Keep the speaker on the intended physical headphones or speakers.
4. If needed, open **More options > Settings > Audio** to review both devices.
5. Send one short corrected phrase before continuing the meeting.

## Pass criteria

- The Meet microphone bar responds to the tones and corrected phrase.
- A participant in the controlled test hears the corrected phrase once.
- The Meet speaker test remains audible through the physical output.
- Cancellation produces no delayed audio.

## Return to the physical microphone

1. Open the microphone device menu or **More options > Settings > Audio**.
2. Change the microphone from `BlackHole 2ch` to the recorded physical microphone.
3. Speak and confirm that the Meet microphone bar moves.
4. Confirm the speaker remains on the intended physical device.
5. Leave the meeting, then close English Corrector.

## Troubleshooting

- If BlackHole is missing, make it available first, then reload the Meet tab.
- If the microphone bar is idle, confirm Meet has browser microphone permission and re-select `BlackHole 2ch`.
- If participants hear echo, use headphones. Google warns that mismatched microphone and external speaker devices can cause echo.
- If the speaker test is silent, change only the Meet speaker to a physical output. Do not route Meet's speaker into BlackHole.
- Do not use the macOS default device as proof that Meet selected the correct microphone. Check Meet's own device menu.

## Official reference

Source checked on 2026-09-15:

- [Connect your video and audio](https://support.google.com/meet/answer/10409699?hl=en)

The official article documents pre-join peripheral selection, microphone and speaker self-checks, and in-meeting device menus. It does not certify this virtual audio route.
