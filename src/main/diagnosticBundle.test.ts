import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiagnosticBundle,
  diagnosticFileName,
  serializeDiagnosticBundle,
} from "./diagnosticBundle";
import { createDiagnosticExportService } from "./diagnosticExport";

const FIXED_TIME = "2026-09-15T00:00:00.000Z";
const FIXED_UUID = "123e4567-e89b-42d3-a456-426614174000";

function fixedEnvironment() {
  return {
    appVersion: "0.1.0",
    platform: "darwin",
    architecture: "x64",
    osRelease: "23.6.0",
    now: () => new Date(FIXED_TIME),
  } as const;
}

describe("buildDiagnosticBundle", () => {
  it("creates a deterministic redacted snapshot", () => {
    const bundle = buildDiagnosticBundle(
      {
        inputDeviceCount: 2,
        outputDeviceCount: 3,
        blackHoleOutputDetected: true,
        totalErrorCount: 4,
        errorCodes: [
          "provider_timeout",
          "device_missing",
          "provider_timeout",
          "untrusted-code",
        ],
        latencyMs: {
          stt: { sampleCount: 10, medianMs: 110, p95Ms: 180, maxMs: 220 },
          tts: { sampleCount: 8, medianMs: 140, p95Ms: 240, maxMs: 300 },
        },
      },
      fixedEnvironment(),
    );

    const json = serializeDiagnosticBundle(bundle);
    assert.equal(
      json,
      `{
  "schemaVersion": 1,
  "createdAt": "${FIXED_TIME}",
  "app": {
    "version": "0.1.0",
    "platform": "darwin",
    "architecture": "x64",
    "osRelease": "23.6.0"
  },
  "audio": {
    "inputDeviceCount": 2,
    "outputDeviceCount": 3,
    "blackHoleOutputDetected": true
  },
  "errors": {
    "totalCount": 4,
    "codes": [
      "device_missing",
      "provider_timeout"
    ]
  },
  "latencyMs": {
    "stt": {
      "sampleCount": 10,
      "medianMs": 110,
      "p95Ms": 180,
      "maxMs": 220
    },
    "correction": null,
    "tts": {
      "sampleCount": 8,
      "medianMs": 140,
      "p95Ms": 240,
      "maxMs": 300
    },
    "relay": null,
    "endToEnd": null
  }
}
`,
    );
    assert.equal(
      diagnosticFileName(bundle.createdAt),
      "english-corrector-diagnostic-20260915T000000Z.json",
    );
  });

  it("never includes caller content, credentials, paths, or sensitive IDs", () => {
    const secrets = [
      "raw-audio-marker",
      "transcript-marker",
      "corrected-text-marker",
      "prompt-marker",
      "token-marker",
      "client-secret-marker",
      "person@example.test",
      "https://private.example.test/report",
      "device-id-marker",
      "device-label-marker",
      "session-id-marker",
      "provider-request-id-marker",
      "error-message-marker",
      "error-stack-marker",
      "nested-payload-marker",
    ];
    const providerError = new Error(secrets[12]);
    providerError.stack = secrets[13];

    const bundle = buildDiagnosticBundle(
      {
        inputDeviceCount: 1,
        outputDeviceCount: 1,
        blackHoleOutputDetected: false,
        errorCodes: ["provider_timeout", secrets[4]],
        rawAudio: Buffer.from(secrets[0]),
        transcript: secrets[1],
        correctedText: secrets[2],
        prompt: secrets[3],
        token: secrets[4],
        clientSecret: secrets[5],
        email: secrets[6],
        url: secrets[7],
        deviceId: secrets[8],
        deviceLabel: secrets[9],
        sessionId: secrets[10],
        providerRequestId: secrets[11],
        error: providerError,
        providerPayload: { text: secrets[14] },
      },
      {
        appVersion: `0.1.0-${secrets[5]}`,
        platform: secrets[6],
        architecture: secrets[8],
        osRelease: secrets[7],
        now: () => new Date(FIXED_TIME),
      },
    );

    const json = serializeDiagnosticBundle(bundle);
    for (const secret of secrets) {
      assert.equal(json.includes(secret), false, `leaked ${secret}`);
    }
    assert.equal(bundle.app.version, "unknown");
    assert.equal(bundle.app.platform, "unknown");
    assert.equal(bundle.app.architecture, "unknown");
    assert.equal(bundle.app.osRelease, "unknown");
    assert.deepEqual(bundle.errors.codes, ["provider_timeout"]);
  });

  it("does not evaluate getters on unknown fields", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {
      inputDeviceCount: 1,
      outputDeviceCount: 2,
    };

    for (const key of ["transcript", "token", "email", "url", "error"]) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("unknown-getter-secret-marker");
        },
      });
    }

    assert.doesNotThrow(() => buildDiagnosticBundle(input, fixedEnvironment()));
    assert.equal(getterCalls, 0);
  });

  it("handles throwing known getters and invalid aggregates safely", () => {
    const input: Record<string, unknown> = {
      inputDeviceCount: -1,
      outputDeviceCount: 1.5,
      totalErrorCount: Number.POSITIVE_INFINITY,
      latencyMs: {
        stt: { sampleCount: 0, medianMs: 1, p95Ms: 2, maxMs: 3 },
        correction: {
          sampleCount: 2,
          medianMs: 300,
          p95Ms: 200,
          maxMs: 400,
        },
      },
    };
    Object.defineProperty(input, "blackHoleOutputDetected", {
      get() {
        throw new Error("known-getter-secret-marker");
      },
    });

    const codes = ["provider_timeout"];
    Object.defineProperty(codes, 0, {
      get() {
        throw new Error("code-getter-secret-marker");
      },
    });
    input.errorCodes = codes;

    const bundle = buildDiagnosticBundle(input, fixedEnvironment());
    assert.deepEqual(bundle.audio, {
      inputDeviceCount: 0,
      outputDeviceCount: 0,
      blackHoleOutputDetected: false,
    });
    assert.deepEqual(bundle.errors, { totalCount: 0, codes: [] });
    assert.equal(bundle.latencyMs.stt, null);
    assert.equal(bundle.latencyMs.correction, null);
  });
});

describe("createDiagnosticExportService", () => {
  it("requires an issued preview and writes the exact reviewed JSON", async () => {
    const dialogCalls: unknown[] = [];
    const writes: Array<{
      filePath: string;
      contents: string;
      encoding: string;
    }> = [];
    const service = createDiagnosticExportService({
      systemInfo: () => fixedEnvironment(),
      now: () => new Date(FIXED_TIME),
      uuid: () => FIXED_UUID,
      showSaveDialog: async (options) => {
        dialogCalls.push(options);
        return { canceled: false, filePath: "/chosen/report.json" };
      },
      writeFile: async (filePath, contents, encoding) => {
        writes.push({ filePath, contents, encoding });
      },
    });

    const blocked = await service.save(`dp-${FIXED_UUID}`);
    assert.deepEqual(blocked, { status: "expired" });
    assert.equal(dialogCalls.length, 0);
    assert.equal(writes.length, 0);

    const preview = service.preview({
      inputDeviceCount: 2,
      outputDeviceCount: 3,
      blackHoleOutputDetected: true,
    });
    assert.equal(preview.previewId, `dp-${FIXED_UUID}`);
    assert.equal(
      preview.fileName,
      "english-corrector-diagnostic-20260915T000000Z.json",
    );
    assert.equal(preview.json.endsWith("\n"), true);

    const saved = await service.save(preview.previewId);
    assert.deepEqual(saved, { status: "saved" });
    assert.equal(dialogCalls.length, 1);
    assert.deepEqual(writes, [
      {
        filePath: "/chosen/report.json",
        contents: preview.json,
        encoding: "utf8",
      },
    ]);
    assert.deepEqual(await service.save(preview.previewId), {
      status: "expired",
    });
  });

  it("does not write when the user cancels", async () => {
    let writes = 0;
    const service = createDiagnosticExportService({
      systemInfo: () => fixedEnvironment(),
      now: () => new Date(FIXED_TIME),
      uuid: () => FIXED_UUID,
      showSaveDialog: async () => ({ canceled: true }),
      writeFile: async () => {
        writes += 1;
      },
    });

    const preview = service.preview({});
    assert.deepEqual(await service.save(preview.previewId), {
      status: "cancelled",
    });
    assert.equal(writes, 0);
  });

  it("expires an old preview before opening the save dialog", async () => {
    let currentTime = new Date(FIXED_TIME);
    let dialogCalls = 0;
    const service = createDiagnosticExportService({
      systemInfo: () => fixedEnvironment(),
      now: () => currentTime,
      uuid: () => FIXED_UUID,
      showSaveDialog: async () => {
        dialogCalls += 1;
        return { canceled: true };
      },
      writeFile: async () => undefined,
    });

    const preview = service.preview({});
    currentTime = new Date(currentTime.getTime() + 11 * 60 * 1000);

    assert.deepEqual(await service.save(preview.previewId), {
      status: "expired",
    });
    assert.equal(dialogCalls, 0);
  });

  it("returns a fixed failure without exposing write errors", async () => {
    const service = createDiagnosticExportService({
      systemInfo: () => fixedEnvironment(),
      now: () => new Date(FIXED_TIME),
      uuid: () => FIXED_UUID,
      showSaveDialog: async () => ({
        canceled: false,
        filePath: "/private/path-marker/report.json",
      }),
      writeFile: async () => {
        throw new Error("write-error-secret-marker");
      },
    });

    const preview = service.preview({});
    assert.deepEqual(await service.save(preview.previewId), {
      status: "failed",
    });
  });

  it("uses a fixed safe error for invalid preview IDs", () => {
    const service = createDiagnosticExportService({
      systemInfo: () => fixedEnvironment(),
      uuid: () => "invalid-id-secret-marker",
      showSaveDialog: async () => ({ canceled: true }),
      writeFile: async () => undefined,
    });

    assert.throws(
      () => service.preview({}),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "diagnostic_preview_id_invalid");
        assert.equal(error.message.includes("secret-marker"), false);
        return true;
      },
    );
  });
});
