import {
  BufferOverflowError,
  ChunkSequenceGapError,
  StreamingChunkBuffer,
} from "../audio/streamingChunkBuffer";
import { PcmFormatError, PcmStreamNormalizer } from "../audio/pcmNormalizer";
import type {
  PipelineSnapshot,
  StreamingAudioSink,
  TtsAdapter,
  UtteranceMetrics,
  UtteranceRequest,
  UtteranceResult,
  UtteranceStage,
} from "./contracts";

export type RunUtteranceOptions = {
  adapter: TtsAdapter;
  request: UtteranceRequest;
  sink: StreamingAudioSink;
  outputDeviceId: string;
  signal: AbortSignal;
  prebufferBytes?: number;
  highWaterBytes?: number;
  now?: () => number;
  onSnapshot?: (snapshot: PipelineSnapshot) => void;
};

class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function errorCode(error: unknown): string {
  if (error instanceof PipelineError) return error.code;
  if (error instanceof BufferOverflowError) return error.code;
  if (error instanceof ChunkSequenceGapError) return error.code;
  if (error instanceof PcmFormatError) return error.code;
  return "unexpected_pipeline_error";
}

export async function runUtterance(
  options: RunUtteranceOptions,
): Promise<UtteranceResult> {
  const now = options.now ?? (() => performance.now());
  const prebufferBytes = Math.max(2, options.prebufferBytes ?? 8_192);
  const highWaterBytes = Math.max(
    prebufferBytes,
    options.highWaterBytes ?? 512 * 1_024,
  );
  const buffer = new StreamingChunkBuffer(highWaterBytes);
  const stagedChunks: Uint8Array[] = [];
  const metrics: UtteranceMetrics = {
    requestStartedAt: now(),
    duplicateChunks: 0,
    outOfOrderChunks: 0,
  };
  let stagedBytes = 0;
  let totalAudioBytes = 0;
  let stage: UtteranceStage = "synthesizing";
  let normalizer: PcmStreamNormalizer | null = null;
  let sinkStarted = false;
  let playbackWritten = false;
  let providerCompleted = false;
  let stopPromise: Promise<void> | null = null;

  const stopSink = () => {
    stopPromise ??= options.sink.stop();
    return stopPromise;
  };
  const handleAbort = () => {
    void stopSink();
  };
  options.signal.addEventListener("abort", handleAbort, { once: true });

  const emit = (error?: string) => {
    options.onSnapshot?.({
      stage,
      bufferedBytes: stagedBytes + buffer.pendingBytes,
      metrics: { ...metrics },
      errorCode: error,
    });
  };

  const setStage = (nextStage: UtteranceStage) => {
    stage = nextStage;
    emit();
  };

  const flushStaged = async () => {
    if (!normalizer) {
      throw new PipelineError(
        "protocol_error",
        "Audio arrived before the provider declared its format.",
      );
    }

    while (stagedChunks.length > 0) {
      assertNotAborted(options.signal);
      const chunk = stagedChunks.shift()!;
      stagedBytes -= chunk.byteLength;
      const frame = normalizer.push(chunk);
      if (!frame) continue;

      if (!playbackWritten) {
        metrics.playbackStartedAt = now();
        playbackWritten = true;
        setStage("playing");
      }

      try {
        await options.sink.write(frame);
      } catch (error) {
        throw new PipelineError(
          "output_device_error",
          error instanceof Error ? error.message : "Audio output failed.",
        );
      }
    }

    emit();
  };

  const startSinkAndFlush = async () => {
    if (sinkStarted) {
      await flushStaged();
      return;
    }

    try {
      await options.sink.start(options.outputDeviceId);
    } catch (error) {
      throw new PipelineError(
        "output_device_error",
        error instanceof Error ? error.message : "Audio output failed.",
      );
    }

    sinkStarted = true;
    await flushStaged();
  };

  emit();

  try {
    if (!options.request.text.trim()) {
      throw new PipelineError("invalid_text", "Text cannot be empty.");
    }
    if (!options.outputDeviceId) {
      throw new PipelineError(
        "output_device_required",
        "An output device is required.",
      );
    }

    for await (const event of options.adapter.synthesize(
      options.request,
      options.signal,
    )) {
      assertNotAborted(options.signal);

      if (event.utteranceId !== options.request.utteranceId) {
        throw new PipelineError(
          "utterance_mismatch",
          "The provider returned an event for another utterance.",
        );
      }

      if (event.type === "started") {
        if (normalizer) {
          throw new PipelineError(
            "protocol_error",
            "The provider emitted started more than once.",
          );
        }
        normalizer = new PcmStreamNormalizer(event.format);
        continue;
      }

      if (event.type === "failed") {
        throw new PipelineError(event.code, "The TTS provider failed.");
      }

      if (event.type === "chunk") {
        if (!normalizer) {
          throw new PipelineError(
            "protocol_error",
            "The provider emitted audio before started.",
          );
        }
        if (metrics.firstChunkAt === undefined) metrics.firstChunkAt = now();

        const pushResult = buffer.push(event.sequence, event.bytes);
        if (pushResult.duplicate) {
          metrics.duplicateChunks += 1;
          emit();
          continue;
        }
        if (pushResult.outOfOrder) metrics.outOfOrderChunks += 1;

        const readyChunks = buffer.drainContiguous();
        for (const chunk of readyChunks) {
          stagedChunks.push(chunk);
          stagedBytes += chunk.byteLength;
          totalAudioBytes += chunk.byteLength;
        }

        if (stagedBytes + buffer.pendingBytes > highWaterBytes) {
          throw new BufferOverflowError(highWaterBytes);
        }

        if (!sinkStarted && stagedBytes < prebufferBytes) {
          setStage("buffering");
        } else if (stagedBytes > 0) {
          await startSinkAndFlush();
        }
        continue;
      }

      if (event.type === "completed") {
        providerCompleted = true;
        metrics.ttsCompletedAt = now();
        const readyChunks = buffer.drainContiguous();
        for (const chunk of readyChunks) {
          stagedChunks.push(chunk);
          stagedBytes += chunk.byteLength;
          totalAudioBytes += chunk.byteLength;
        }
        buffer.assertComplete();
        break;
      }
    }

    if (!providerCompleted) {
      throw new PipelineError(
        "provider_stream_incomplete",
        "The provider stream ended without completed.",
      );
    }
    if (!normalizer || totalAudioBytes === 0) {
      throw new PipelineError("empty_audio", "The provider returned no audio.");
    }

    await startSinkAndFlush();
    normalizer.finish();

    try {
      await options.sink.drain();
      assertNotAborted(options.signal);
    } catch (error) {
      throw new PipelineError(
        "output_device_error",
        error instanceof Error ? error.message : "Audio output failed.",
      );
    }

    metrics.playbackCompletedAt = now();
    await stopSink();
    setStage("completed");
    return { stage: "completed", metrics: { ...metrics } };
  } catch (error) {
    buffer.clear();
    await stopSink();

    if (
      options.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      stage = "cancelled";
      emit("cancelled");
      return { stage: "cancelled", metrics: { ...metrics } };
    }

    const code = errorCode(error);
    stage = "failed";
    emit(code);
    return { stage: "failed", metrics: { ...metrics }, errorCode: code };
  } finally {
    options.signal.removeEventListener("abort", handleAbort);
  }
}
