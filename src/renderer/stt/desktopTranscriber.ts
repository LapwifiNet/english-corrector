import type { SttBridge } from "../../shared/stt";
import type {
  StartTranscriptionRequest,
  StreamingTranscriber,
  TranscriptionSession,
} from "./contracts";
import { createIpcTranscriber } from "./ipcTranscriber";

export type DesktopTranscriberOptions = {
  /** Missing in a browser build or before the preload script has run. */
  bridge?: SttBridge;
  /** Used when no provider key is configured, so the app still runs offline. */
  fallback: StreamingTranscriber;
  sampleRate?: number;
};

/**
 * Picks the real provider when one is configured and the deterministic fake
 * otherwise. The status answer is asynchronous, so a phrase started before it
 * arrives goes to the provider: a desktop build with the bridge present is
 * the configured case, and a missing key comes back as a failed phrase.
 */
export function createDesktopTranscriber(
  options: DesktopTranscriberOptions,
): StreamingTranscriber {
  const { bridge, fallback } = options;
  if (!bridge) return fallback;

  const provider = createIpcTranscriber(bridge, options.sampleRate);
  let configured: boolean | null = null;

  void bridge
    .getStatus()
    .then((status) => {
      configured = status.configured;
    })
    .catch(() => {
      configured = false;
    });

  return {
    start(request: StartTranscriptionRequest): TranscriptionSession {
      const transcriber = configured === false ? fallback : provider;
      return transcriber.start(request);
    },
  };
}
