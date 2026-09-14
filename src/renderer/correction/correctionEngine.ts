import { parseCorrectionOutput } from "./responseParser";
import { CORRECTION_PROMPT_VERSION } from "./correctionPrompt";
import { extractProtectedTokens } from "./protectedTokens";
import { validateCorrection } from "./invariantValidators";
import {
  CorrectionCancelled,
  type CorrectionAdapter,
  type CorrectionErrorCode,
  type CorrectionRequest,
  type CorrectionResult,
  type CorrectionWarning,
} from "./contracts";

export type CancelTimer = () => void;
export type ScheduleTimeout = (ms: number, fn: () => void) => CancelTimer;

export type CorrectionEngineDeps = {
  adapter: CorrectionAdapter;
  /** Hard deadline for one model call. No second attempt is made. */
  timeoutMs?: number;
  maxLengthRatio?: number;
  scheduleTimeout?: ScheduleTimeout;
  now?: () => number;
  promptVersion?: string;
};

export type CorrectionEngine = {
  correct(
    request: CorrectionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CorrectionResult>;
};

const defaultScheduleTimeout: ScheduleTimeout = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createCorrectionEngine(
  deps: CorrectionEngineDeps,
): CorrectionEngine {
  const timeoutMs = deps.timeoutMs ?? 1500;
  const scheduleTimeout = deps.scheduleTimeout ?? defaultScheduleTimeout;
  const now = deps.now ?? (() => Date.now());
  const promptVersion = deps.promptVersion ?? CORRECTION_PROMPT_VERSION;

  function fallback(
    request: CorrectionRequest,
    originalText: string,
    warnings: CorrectionWarning[],
    errorCode: CorrectionErrorCode,
    providerLatencyMs?: number,
  ): CorrectionResult {
    return {
      phraseId: request.phraseId,
      originalText,
      correctedText: originalText,
      outcome: "fallback",
      warnings,
      errorCode,
      providerLatencyMs,
      promptVersion,
    };
  }

  return {
    async correct(request, options = {}) {
      const externalSignal = options.signal;
      if (externalSignal?.aborted)
        throw new CorrectionCancelled(request.phraseId);

      const originalText = request.originalText.trim();
      if (originalText.length === 0) {
        return fallback(
          request,
          request.originalText,
          ["invalid_output"],
          "empty_input",
        );
      }

      const protectedTokens = extractProtectedTokens(originalText);
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      externalSignal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });

      let timedOut = false;
      const cancelTimer = scheduleTimeout(timeoutMs, () => {
        timedOut = true;
        controller.abort();
      });

      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new CorrectionCancelled(request.phraseId)),
          { once: true },
        );
      });
      abortPromise.catch(() => {});

      const startedAt = now();
      let raw: string;
      try {
        const pending = deps.adapter.correct(
          { ...request, originalText },
          controller.signal,
        );
        pending.catch(() => {});
        raw = await Promise.race([pending, abortPromise]);
      } catch (error) {
        const latency = now() - startedAt;
        if (timedOut)
          return fallback(request, originalText, [], "timeout", latency);
        if (externalSignal?.aborted)
          throw new CorrectionCancelled(request.phraseId);
        return fallback(request, originalText, [], "provider_error", latency);
      } finally {
        cancelTimer();
        externalSignal?.removeEventListener("abort", abortFromCaller);
      }

      const providerLatencyMs = now() - startedAt;
      if (externalSignal?.aborted)
        throw new CorrectionCancelled(request.phraseId);

      const parsed = parseCorrectionOutput(raw);
      if (!parsed.ok) {
        return fallback(
          request,
          originalText,
          ["invalid_output"],
          "invalid_output",
          providerLatencyMs,
        );
      }

      const warnings = validateCorrection(
        originalText,
        parsed.text,
        protectedTokens,
        {
          maxLengthRatio: deps.maxLengthRatio,
        },
      );
      if (warnings.length > 0) {
        return fallback(
          request,
          originalText,
          warnings,
          "unsafe_output",
          providerLatencyMs,
        );
      }

      return {
        phraseId: request.phraseId,
        originalText,
        correctedText: parsed.text,
        outcome: parsed.text === originalText ? "unchanged" : "changed",
        warnings: [],
        providerLatencyMs,
        promptVersion,
      };
    },
  };
}
