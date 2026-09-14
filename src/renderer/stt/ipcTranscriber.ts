import {
  STT_SAMPLE_RATE,
  type SttBridge,
  type SttBridgeEvent,
} from "../../shared/stt";
import type {
  StartTranscriptionRequest,
  StreamingTranscriber,
  TranscriptionSession,
} from "./contracts";
import { encodePcmChunk } from "./pcmEncoder";

/** How long a continuous session waits for one last transcript on finish. */
const FINISH_GRACE_MS = 2_500;

/**
 * Speaks to the real provider through the main process. The renderer never
 * holds the API key and only sees transcript events.
 */
export function createIpcTranscriber(
  bridge: SttBridge,
  targetSampleRate: number = STT_SAMPLE_RATE,
): StreamingTranscriber {
  return {
    start(request: StartTranscriptionRequest): TranscriptionSession {
      const { phraseId, signal, onEvent } = request;
      const continuous = request.mode === "continuous";

      let closed = false;
      let finishing = false;
      let unsubscribe: () => void = () => {};
      let settle: () => void = () => {};
      const completion = new Promise<void>((resolve) => {
        settle = resolve;
      });

      const stop = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        settle();
      };

      const handleEvent = (event: SttBridgeEvent): void => {
        if (closed || event.phraseId !== phraseId) return;
        if (signal.aborted) {
          stop();
          return;
        }

        if (event.type === "partial") {
          onEvent({
            type: "partial_transcript",
            phraseId,
            revision: event.revision,
            text: event.text,
            ...(event.utterance === undefined
              ? {}
              : { utterance: event.utterance }),
          });
          return;
        }

        if (event.type === "final") {
          onEvent({
            type: "final_transcript",
            phraseId,
            text: event.text,
            receivedAt: event.receivedAt,
            confidence: event.confidence,
            ...(event.utterance === undefined
              ? {}
              : { utterance: event.utterance }),
          });
          // Hands-free mode expects more sentences on the same session, so it
          // stays open until the caller asks to finish.
          if (continuous && !finishing) return;

          stop();
          return;
        }

        onEvent({ type: "failed", phraseId, code: event.code });
        stop();
      };

      unsubscribe = bridge.onEvent(handleEvent);
      signal.addEventListener("abort", () => {
        if (closed) return;
        bridge.cancel(phraseId);
        stop();
      });

      bridge.start({
        phraseId,
        sampleRate: targetSampleRate,
        ...(request.mode === undefined ? {} : { mode: request.mode }),
      });

      return {
        write: (frame) => {
          if (closed || frame.phraseId !== phraseId) return;

          const pcm = encodePcmChunk(
            frame.samples,
            frame.sampleRate,
            targetSampleRate,
          );
          if (pcm.byteLength === 0) return;

          bridge.sendAudio({ phraseId, sequence: frame.sequence, pcm });
        },
        finish: () => {
          if (closed) return Promise.resolve();

          finishing = true;
          bridge.finish(phraseId);
          if (!continuous) return completion;

          // A continuous session may have nothing left to flush, so waiting
          // for one more transcript must not hang the caller.
          return Promise.race([
            completion,
            new Promise<void>((resolve) => {
              setTimeout(() => {
                stop();
                resolve();
              }, FINISH_GRACE_MS);
            }),
          ]);
        },
        cancel: () => {
          if (closed) return;
          bridge.cancel(phraseId);
          stop();
        },
      };
    },
  };
}
