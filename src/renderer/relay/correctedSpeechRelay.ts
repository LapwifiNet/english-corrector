import type { PhraseId } from "../correction/contracts";
import {
  isSpeakable,
  type CorrectionSnapshot,
} from "../correction/correctionPipeline";
import type {
  PipelineSnapshot,
  StreamingAudioSink,
  TtsAdapter,
  UtteranceMetrics,
  UtteranceResult,
} from "../tts/contracts";
import { createUtteranceId } from "../tts/contracts";
import { runUtterance, type RunUtteranceOptions } from "../tts/runUtterance";

export type RelayPlaybackPhase =
  | "idle"
  | "preparing"
  | "synthesizing"
  | "buffering"
  | "playing"
  | "completed"
  | "cancelled"
  | "failed";

export type RelayRoute = {
  adapter: TtsAdapter;
  voiceId: string;
  voiceLabel?: string;
  outputDeviceId: string;
  outputLabel?: string;
};

export type RelayPlaybackSnapshot = {
  phase: RelayPlaybackPhase;
  phraseId: PhraseId | null;
  spokenText: string;
  provider: string | null;
  voiceId: string | null;
  voiceLabel: string | null;
  outputDeviceId: string | null;
  outputLabel: string | null;
  bufferedBytes: number;
  metrics: UtteranceMetrics | null;
  errorCode?: string;
};

export const INITIAL_RELAY_PLAYBACK_SNAPSHOT: RelayPlaybackSnapshot = {
  phase: "idle",
  phraseId: null,
  spokenText: "",
  provider: null,
  voiceId: null,
  voiceLabel: null,
  outputDeviceId: null,
  outputLabel: null,
  bufferedBytes: 0,
  metrics: null,
};

export class RelayRouteError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RelayRouteError";
  }
}

type RunRelayUtterance = (
  options: RunUtteranceOptions,
) => Promise<UtteranceResult>;

export type CorrectedSpeechRelayDeps = {
  resolveRoute: () => Promise<RelayRoute>;
  createSink: () => StreamingAudioSink;
  run?: RunRelayUtterance;
  createUtteranceId?: () => string;
  onSnapshot?: (snapshot: RelayPlaybackSnapshot) => void;
};

type ActiveRun = {
  phraseId: PhraseId;
  controller: AbortController;
};

export function isRelayPlaybackBusy(snapshot: RelayPlaybackSnapshot): boolean {
  return ["preparing", "synthesizing", "buffering", "playing"].includes(
    snapshot.phase,
  );
}

function terminalPhase(result: UtteranceResult): RelayPlaybackPhase {
  return result.stage;
}

function routeErrorCode(error: unknown): string {
  if (error instanceof RelayRouteError) return error.code;
  return "relay_setup_failed";
}

/**
 * Epic 4 handoff from a safe correction snapshot into exactly one TTS run.
 * Route details are resolved once per phrase and become immutable for that run.
 */
export class CorrectedSpeechRelay {
  private current = INITIAL_RELAY_PLAYBACK_SNAPSHOT;
  private active: ActiveRun | null = null;
  private readonly submittedPhraseIds = new Set<PhraseId>();
  private readonly run: RunRelayUtterance;
  private readonly makeUtteranceId: () => string;

  constructor(private readonly deps: CorrectedSpeechRelayDeps) {
    this.run = deps.run ?? runUtterance;
    this.makeUtteranceId = deps.createUtteranceId ?? createUtteranceId;
  }

  snapshot(): RelayPlaybackSnapshot {
    return this.current;
  }

  async submit(correction: CorrectionSnapshot): Promise<RelayPlaybackSnapshot> {
    if (!isSpeakable(correction) || !correction.phraseId) return this.current;

    const phraseId = correction.phraseId;
    const spokenText = correction.spokenText.trim();
    if (!spokenText || this.submittedPhraseIds.has(phraseId)) {
      return this.current;
    }
    this.remember(phraseId);
    this.supersedeActive();

    const controller = new AbortController();
    const active: ActiveRun = { phraseId, controller };
    this.active = active;
    this.publish({
      ...INITIAL_RELAY_PLAYBACK_SNAPSHOT,
      phase: "preparing",
      phraseId,
      spokenText,
    });

    try {
      const route = await this.deps.resolveRoute();
      if (this.active !== active || controller.signal.aborted) {
        return this.current;
      }
      if (!route.outputDeviceId) {
        throw new RelayRouteError("output_device_required");
      }
      if (!route.voiceId) throw new RelayRouteError("tts_voice_required");

      const sink = this.deps.createSink();
      const routeSnapshot = {
        provider: route.adapter.provider,
        voiceId: route.voiceId,
        voiceLabel: route.voiceLabel ?? route.voiceId,
        outputDeviceId: route.outputDeviceId,
        outputLabel: route.outputLabel ?? route.outputDeviceId,
      };
      this.publish({
        ...this.current,
        ...routeSnapshot,
        phase: "synthesizing",
      });

      const result = await this.run({
        adapter: route.adapter,
        request: {
          utteranceId: this.makeUtteranceId(),
          text: spokenText,
          voiceId: route.voiceId,
        },
        sink,
        outputDeviceId: route.outputDeviceId,
        signal: controller.signal,
        onSnapshot: (pipeline) => {
          if (this.active !== active) return;
          this.publishPipelineSnapshot(pipeline, routeSnapshot);
        },
      });

      if (this.active !== active) return this.current;
      this.active = null;
      return this.publish({
        ...this.current,
        ...routeSnapshot,
        phase: terminalPhase(result),
        bufferedBytes: 0,
        metrics: { ...result.metrics },
        errorCode: result.errorCode,
      });
    } catch (error) {
      if (this.active !== active) return this.current;
      this.active = null;
      if (controller.signal.aborted) {
        return this.publish({ ...this.current, phase: "cancelled" });
      }
      return this.publish({
        ...this.current,
        phase: "failed",
        errorCode: routeErrorCode(error),
      });
    }
  }

  cancel(phraseId?: PhraseId): void {
    const active = this.active;
    if (!active) return;
    if (phraseId !== undefined && phraseId !== active.phraseId) return;

    this.active = null;
    active.controller.abort();
    this.publish({
      ...this.current,
      phase: "cancelled",
      bufferedBytes: 0,
    });
  }

  private supersedeActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.controller.abort();
  }

  private publishPipelineSnapshot(
    pipeline: PipelineSnapshot,
    route: Pick<
      RelayPlaybackSnapshot,
      "provider" | "voiceId" | "voiceLabel" | "outputDeviceId" | "outputLabel"
    >,
  ): void {
    if (
      pipeline.stage !== "synthesizing" &&
      pipeline.stage !== "buffering" &&
      pipeline.stage !== "playing"
    ) {
      return;
    }

    this.publish({
      ...this.current,
      ...route,
      phase: pipeline.stage,
      bufferedBytes: pipeline.bufferedBytes,
      metrics: { ...pipeline.metrics },
      errorCode: pipeline.errorCode,
    });
  }

  private remember(phraseId: PhraseId): void {
    this.submittedPhraseIds.add(phraseId);
    if (this.submittedPhraseIds.size <= 128) return;
    const oldest = this.submittedPhraseIds.values().next().value;
    if (oldest) this.submittedPhraseIds.delete(oldest);
  }

  private publish(snapshot: RelayPlaybackSnapshot): RelayPlaybackSnapshot {
    this.current = snapshot;
    this.deps.onSnapshot?.(snapshot);
    return snapshot;
  }
}

export function createCorrectedSpeechRelay(
  deps: CorrectedSpeechRelayDeps,
): CorrectedSpeechRelay {
  return new CorrectedSpeechRelay(deps);
}
