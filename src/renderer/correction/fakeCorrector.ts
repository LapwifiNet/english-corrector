import type { CorrectionAdapter, CorrectionRequest } from "./contracts";

export type FakeBehavior =
  | { type: "echo" }
  | { type: "fixed"; output: string }
  | { type: "scripted"; outputs: Record<string, string> }
  | { type: "never" }
  | { type: "error"; message?: string };

export type FakeCorrector = CorrectionAdapter & {
  /** Number of model calls. Used to prove the engine never retries. */
  readonly callCount: number;
  readonly lastRequest: CorrectionRequest | undefined;
};

/**
 * Deterministic corrector used by every automated test. No network, no model,
 * so correction tests stay reproducible.
 */
export function createFakeCorrector(
  behavior: FakeBehavior = { type: "echo" },
): FakeCorrector {
  let callCount = 0;
  let lastRequest: CorrectionRequest | undefined;

  return {
    name: "fake",
    get callCount() {
      return callCount;
    },
    get lastRequest() {
      return lastRequest;
    },
    async correct(request, signal) {
      callCount += 1;
      lastRequest = request;

      if (behavior.type === "never") {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }

      if (behavior.type === "error") {
        throw new Error(behavior.message ?? "provider failed");
      }

      if (behavior.type === "fixed") return behavior.output;
      if (behavior.type === "echo") return request.originalText;

      const scripted = behavior.outputs[request.originalText];
      if (scripted === undefined) {
        throw new Error("No scripted output for: " + request.originalText);
      }
      return scripted;
    },
  };
}

export type ManualTimer = {
  schedule: (ms: number, fn: () => void) => () => void;
  /** Runs every pending timer, used to simulate a provider deadline. */
  fireAll: () => void;
  readonly pendingCount: number;
};

export function createManualTimer(): ManualTimer {
  let pending: Array<{ fn: () => void; cancelled: boolean }> = [];

  return {
    schedule(_ms, fn) {
      const entry = { fn, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    fireAll() {
      const current = pending;
      pending = [];
      current
        .filter((entry) => !entry.cancelled)
        .forEach((entry) => entry.fn());
    },
    get pendingCount() {
      return pending.filter((entry) => !entry.cancelled).length;
    },
  };
}
