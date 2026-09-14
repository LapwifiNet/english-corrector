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

      let closed = false;
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
          });
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

      bridge.start({ phraseId, sampleRate: targetSampleRate });

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
          bridge.finish(phraseId);
          return completion;
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
