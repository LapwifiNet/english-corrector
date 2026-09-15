import { useState } from "react";
import type {
  DiagnosticPreviewRequest,
  DiagnosticPreviewResponse,
} from "../shared/diagnostics";

type PanelState =
  | "idle"
  | "previewing"
  | "ready"
  | "saving"
  | "saved"
  | "cancelled"
  | "expired"
  | "failed";

async function audioSummary(): Promise<DiagnosticPreviewRequest> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return {
      inputDeviceCount: 0,
      outputDeviceCount: 0,
      blackHoleOutputDetected: false,
    };
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(
      (device) => device.kind === "audioinput",
    );
    const audioOutputs = devices.filter(
      (device) => device.kind === "audiooutput",
    );

    return {
      inputDeviceCount: audioInputs.length,
      outputDeviceCount: audioOutputs.length,
      blackHoleOutputDetected: audioOutputs.some((device) =>
        /blackhole/i.test(device.label),
      ),
    };
  } catch {
    return {
      inputDeviceCount: 0,
      outputDeviceCount: 0,
      blackHoleOutputDetected: false,
    };
  }
}

function statusMessage(state: PanelState, fileName?: string): string {
  switch (state) {
    case "previewing":
      return "Building a redacted report in memory.";
    case "ready":
      return `Review ${fileName ?? "the JSON report"} before saving.`;
    case "saving":
      return "Waiting for a local save location.";
    case "saved":
      return "The reviewed JSON report was saved locally.";
    case "cancelled":
      return "Save was cancelled. The preview is still available.";
    case "expired":
      return "The preview expired. Generate a new one before saving.";
    case "failed":
      return "The diagnostic action failed safely. No report was uploaded.";
    default:
      return "Generate a local preview. Nothing is uploaded automatically.";
  }
}

export function DiagnosticsPanel() {
  const bridge = window.desktopApi?.diagnostics;
  const [state, setState] = useState<PanelState>("idle");
  const [preview, setPreview] = useState<DiagnosticPreviewResponse | null>(
    null,
  );
  const busy = state === "previewing" || state === "saving";

  const createPreview = async () => {
    if (!bridge || busy) return;

    setState("previewing");
    try {
      const nextPreview = await bridge.preview(await audioSummary());
      setPreview(nextPreview);
      setState("ready");
    } catch {
      setPreview(null);
      setState("failed");
    }
  };

  const savePreview = async () => {
    if (!bridge || !preview || busy) return;

    setState("saving");
    try {
      const result = await bridge.save(preview.previewId);
      setState(result.status);
      if (result.status === "expired") setPreview(null);
    } catch {
      setState("failed");
    }
  };

  return (
    <section
      className="diagnostics-panel"
      aria-labelledby="diagnostics-heading"
    >
      <div className="diagnostics-heading">
        <div>
          <p className="section-label">PRIVACY · DIAGNOSTICS</p>
          <h2 id="diagnostics-heading">Preview before export</h2>
          <p>
            The report contains fixed technical metadata, limited device counts,
            stable error codes, and aggregate latency only.
          </p>
        </div>
        <span className="diagnostics-local-badge">Local JSON</span>
      </div>

      <div className="diagnostics-exclusions">
        <strong>Always excluded</strong>
        <span>Audio</span>
        <span>Transcript</span>
        <span>Corrected text</span>
        <span>Credentials</span>
        <span>Device labels and IDs</span>
        <span>File paths</span>
      </div>

      {!bridge && (
        <p className="diagnostics-notice" role="status">
          Diagnostic export is available in the desktop app. Browser diagnostic
          mode remains unchanged.
        </p>
      )}

      <div className="diagnostics-actions">
        <button
          className="secondary-button"
          disabled={!bridge || busy}
          onClick={() => void createPreview()}
        >
          {preview ? "Refresh preview" : "Generate preview"}
        </button>
        {preview && state !== "saved" && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void savePreview()}
          >
            Save reviewed JSON
          </button>
        )}
      </div>

      <p className={`diagnostics-status state-${state}`} aria-live="polite">
        {statusMessage(state, preview?.fileName)}
      </p>

      {preview && (
        <div className="diagnostics-preview">
          <div>
            <strong>{preview.fileName}</strong>
            <small>Review every field below before choosing Save.</small>
          </div>
          <pre aria-label="Redacted diagnostic JSON preview">
            {preview.json}
          </pre>
        </div>
      )}
    </section>
  );
}
