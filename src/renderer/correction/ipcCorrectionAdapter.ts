import type {
  CorrectionBridge,
  CorrectionBridgeErrorCode,
} from "../../shared/correction";
import type { CorrectionAdapter, CorrectionRequest } from "./contracts";

export class CorrectionProviderFailure extends Error {
  readonly code: CorrectionBridgeErrorCode;

  constructor(code: CorrectionBridgeErrorCode) {
    super("Correction provider failed with " + code);
    this.name = "CorrectionProviderFailure";
    this.code = code;
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Adapts the preload bridge to the domain port. The bridge is request and
 * response, so the main process owns the network deadline. The engine keeps
 * its own deadline and abandons a late answer.
 */
export class IpcCorrectionAdapter implements CorrectionAdapter {
  readonly name = "ipc";

  constructor(private readonly bridge: CorrectionBridge) {}

  async correct(
    request: CorrectionRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw abortError();

    const response = await this.bridge.correct({
      phraseId: request.phraseId,
      originalText: request.originalText,
    });

    if (signal.aborted) throw abortError();
    if (!response.ok) throw new CorrectionProviderFailure(response.code);

    return response.text;
  }
}

export function createIpcCorrectionAdapter(
  bridge: CorrectionBridge,
): CorrectionAdapter {
  return new IpcCorrectionAdapter(bridge);
}
