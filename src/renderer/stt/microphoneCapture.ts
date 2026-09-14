import type { CapturedAudioFrame, PhraseId } from "./contracts";

export type MicrophoneCaptureErrorCode =
  | "microphone_permission_denied"
  | "microphone_not_found"
  | "microphone_busy"
  | "microphone_unsupported"
  | "microphone_capture_failed";

export class MicrophoneCaptureError extends Error {
  constructor(
    readonly code: MicrophoneCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MicrophoneCaptureError";
  }
}

export type MicrophoneCaptureSession = {
  stop: () => Promise<void>;
};

export type StartMicrophoneCaptureOptions = {
  phraseId: PhraseId;
  deviceId: string;
  onFrame: (frame: CapturedAudioFrame) => void;
  onLevel: (level: number) => void;
  onError?: (error: MicrophoneCaptureError) => void;
};

export function buildMicrophoneConstraints(
  deviceId: string,
): MediaStreamConstraints {
  return {
    video: false,
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    },
  };
}

export function microphoneErrorCode(
  error: unknown,
): MicrophoneCaptureErrorCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "microphone_permission_denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "microphone_not_found";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "microphone_busy";
  }
  if (name === "NotSupportedError") return "microphone_unsupported";
  return "microphone_capture_failed";
}

function captureError(error: unknown): MicrophoneCaptureError {
  return new MicrophoneCaptureError(
    microphoneErrorCode(error),
    error instanceof Error ? error.message : "Microphone capture failed.",
  );
}

export class BrowserMicrophoneCapture {
  async start(
    options: StartMicrophoneCaptureOptions,
  ): Promise<MicrophoneCaptureSession> {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
      throw new MicrophoneCaptureError(
        "microphone_unsupported",
        "Microphone capture is unavailable in this environment.",
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        buildMicrophoneConstraints(options.deviceId),
      );
    } catch (error) {
      throw captureError(error);
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2_048, 1, 1);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    let sequence = 0;
    let stopped = false;

    processor.onaudioprocess = (event) => {
      if (stopped) return;
      try {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        let squared = 0;
        for (const sample of samples) squared += sample * sample;
        const rms = samples.length ? Math.sqrt(squared / samples.length) : 0;
        options.onLevel(Math.min(1, rms * 8));
        options.onFrame({
          phraseId: options.phraseId,
          sequence,
          capturedAt: performance.now(),
          sampleRate: context.sampleRate,
          samples,
        });
        sequence += 1;
      } catch (error) {
        options.onError?.(captureError(error));
      }
    };

    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    await context.resume();

    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        silentOutput.disconnect();
        for (const track of stream.getTracks()) track.stop();
        options.onLevel(0);
        if (context.state !== "closed") await context.close();
      },
    };
  }
}
