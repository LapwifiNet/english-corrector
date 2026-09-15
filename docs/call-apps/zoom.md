# Zoom setup

Status: source-checked beta checklist. A real Zoom call with BlackHole still needs macOS Intel validation.

Start with the [shared preparation and route test](./README.md).

## Configure before a meeting

1. Open English Corrector first and confirm `BlackHole 2ch` is ready.
2. Open the Zoom desktop app.
3. Select the profile picture, then **Settings**.
4. Open **Audio**.
5. Under **Speaker**, select physical headphones or speakers. Do not select BlackHole.
6. Under **Microphone**, select `BlackHole 2ch`.
7. Keep English Corrector open while Zoom uses the virtual input.

## Test the microphone

1. In Zoom **Audio** settings, click **Test speaker** and confirm the sound comes from the intended physical output.
2. Under **Microphone**, click **Test microphone**.
3. While Zoom records, click **Play three tones** in English Corrector.
4. Confirm the Zoom input volume meter moves and the replay contains the three tones once.
5. Run the corrected speech step from the shared route test.
6. Confirm the replay contains one corrected phrase without raw microphone passthrough.
7. End the test before joining the meeting.

Zoom also offers **Test speaker and microphone** while joining. The same route rules apply.

## Change the route during a meeting

1. In the meeting controls, select the arrow next to **Mute** or **Unmute**.
2. Select `BlackHole 2ch` as the microphone.
3. Confirm the speaker remains the intended physical headphones or speakers.
4. Send one short corrected phrase before continuing the meeting.

## Pass criteria

- Zoom's microphone meter responds to English Corrector output.
- The test replay contains the tones and corrected phrase once each.
- The Zoom speaker remains physical and audible.
- Cancelling an English Corrector phrase produces no delayed audio.

## Return to the physical microphone

1. Select the arrow next to **Mute** or open **Settings > Audio**.
2. Change **Microphone** from `BlackHole 2ch` to the recorded physical microphone.
3. Run **Test microphone** and speak directly.
4. Confirm the input meter and replay respond to the physical microphone.
5. Close English Corrector only after Zoom is back on the physical input.

## Troubleshooting

- If BlackHole is missing from Zoom, quit and reopen Zoom after BlackHole is available.
- If Zoom receives silence, confirm English Corrector has `BlackHole 2ch` selected as **Virtual output** and Zoom has it selected as **Microphone**.
- If audio feeds back, use headphones and confirm Zoom **Speaker** is not BlackHole.
- If Zoom cannot access any microphone, review Zoom's macOS microphone permission before changing the route.
- Do not enable automatic retries or run two English Corrector instances to work around silence.

## Official reference

Source checked on 2026-09-15:

- [Testing your audio settings for Zoom meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062765)

The official article documents **Settings > Audio**, **Test speaker**, **Test microphone**, join-time testing, and the microphone selector next to **Mute**. It does not certify this virtual audio route.
