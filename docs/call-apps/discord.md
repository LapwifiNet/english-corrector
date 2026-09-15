# Discord setup

Status: source-checked beta checklist. A real Discord voice channel with BlackHole still needs macOS Intel validation.

Start with the [shared preparation and route test](./README.md).

## Configure Discord

1. Open English Corrector first and confirm `BlackHole 2ch` is ready.
2. Open Discord desktop or Discord in a desktop browser.
3. Select the cogwheel to open **User Settings**.
4. Open **Voice & Video**, then stay on the **Voice** section.
5. Set **Input Device** to `BlackHole 2ch`.
6. Set **Output Device** to physical headphones or speakers. Do not select BlackHole as the output.
7. Confirm **Input Mode** is intentional. Use **Voice Activity** for the first route test unless Discord push-to-talk is specifically required.
8. Keep English Corrector open while Discord uses the virtual input.

## Test the microphone

1. Under **Mic Test**, select **Let's Check**.
2. Click **Play three tones** in English Corrector.
3. Confirm Discord plays the captured tones back once through the physical output.
4. Run the corrected speech step from the shared route test.
5. Confirm Discord plays one corrected phrase back.
6. Select **Stop Testing** when finished.

Discord notes that Mic Test is available only on desktop and browser. If it is started while connected to a voice channel, Discord automatically mutes and deafens the user until the test ends.

## Test a voice channel

1. Join a controlled voice channel after Mic Test passes.
2. Confirm the channel permits **Connect** and **Speak**.
3. Verify that Discord is not muted or deafened.
4. Send one short corrected phrase.
5. Ask the test listener to confirm it arrived once and was intelligible.
6. Cancel the next active phrase and confirm no remainder is heard.

## Pass criteria

- Mic Test plays the tones and corrected phrase once each.
- A listener in the controlled channel hears one corrected phrase.
- Discord output remains audible through the physical device.
- Cancelling leaves no delayed playback.

## Return to the physical microphone

1. Open **User Settings > Voice & Video > Voice**.
2. Change **Input Device** from `BlackHole 2ch` to the recorded physical microphone.
3. Start **Let's Check**, speak directly, and confirm the playback.
4. Select **Stop Testing**.
5. Confirm **Output Device** is still the intended physical device.
6. Leave the voice channel, then close English Corrector.

## Troubleshooting

- If BlackHole is missing, quit and reopen Discord after BlackHole is available.
- If Discord receives silence, verify **Input Device**, **Input Mode**, mute state, and channel **Speak** permission.
- If tones work but speech is clipped, test corrected speech before changing processing settings. Noise suppression or input sensitivity can affect the signal.
- If needed for diagnosis, temporarily disable noise suppression, test once, then restore the previous setting.
- If settings appear corrupted, Discord documents **Voice & Video > Debugging > Reset Voice and Video Settings**. Record the current physical input and output first because reset changes user settings.
- If there is feedback, use headphones and confirm **Output Device** is not BlackHole.

## Official references

Sources checked on 2026-09-15:

- [Mic Testing](https://support.discord.com/hc/en-us/articles/360020641332-Mic-Testing)
- [Voice and Video Troubleshooting Guide](https://support.discord.com/hc/en-us/articles/360045138471-Discord-Voice-and-Video-Troubleshooting-Guide)

The official articles document **Input Device**, **Output Device**, **Mic Test**, **Let's Check**, **Stop Testing**, input mode, mute state, and reset controls. They do not certify this virtual audio route.
