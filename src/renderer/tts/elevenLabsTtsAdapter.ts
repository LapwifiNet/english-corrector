import type {
  TtsBridge,
  TtsBridgeEvent,
  TtsProviderStatus,
} from "../../shared/tts";
import type {
  TtsAdapter,
  TtsEvent,
  TtsVoice,
  UtteranceRequest,
} from "./contracts";

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

class AsyncEventQueue {
  private readonly events: TtsEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<TtsEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(event: TtsEvent): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.events.push(event);
  }

  close(): void {
    if (this.closed || this.failure) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<TtsEvent>> {
    if (this.events.length > 0) {
      return Promise.resolve({ done: false, value: this.events.shift()! });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function toDomainEvent(event: TtsBridgeEvent): TtsEvent {
  if (event.type !== "chunk") return event;
  return { ...event, bytes: new Uint8Array(event.bytes) };
}

export class ElevenLabsTtsAdapter implements TtsAdapter {
  readonly provider = "elevenlabs";
  private readonly voices: readonly TtsVoice[];

  constructor(
    private readonly bridge: TtsBridge,
    private readonly status: TtsProviderStatus,
  ) {
    this.voices = status.voiceId
      ? [
          {
            id: status.voiceId,
            name: `ElevenLabs · ${status.modelId}`,
            locale: "en-US",
          },
        ]
      : [];
  }

  listVoices(): readonly TtsVoice[] {
    return this.voices;
  }

  async *synthesize(
    request: UtteranceRequest,
    signal: AbortSignal,
  ): AsyncIterable<TtsEvent> {
    if (!this.status.configured || !this.status.voiceId) {
      yield {
        type: "failed",
        utteranceId: request.utteranceId,
        code: "provider_not_configured",
      };
      return;
    }
    if (signal.aborted) throw abortError();

    const queue = new AsyncEventQueue();
    const unsubscribe = this.bridge.onEvent((bridgeEvent) => {
      if (bridgeEvent.utteranceId !== request.utteranceId) return;
      const event = toDomainEvent(bridgeEvent);
      queue.push(event);
      if (event.type === "completed" || event.type === "failed") queue.close();
    });
    const onAbort = () => {
      this.bridge.cancel(request.utteranceId);
      queue.fail(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      this.bridge.start(request);
      while (true) {
        const result = await queue.next();
        if (result.done) return;
        yield result.value;
        if (
          result.value.type === "completed" ||
          result.value.type === "failed"
        ) {
          return;
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }
}
