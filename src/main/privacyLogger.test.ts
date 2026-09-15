import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPrivacyLogger,
  type PrivacyLogFields,
  type PrivacyLogRecord,
} from "./privacyLogger";

const FIXED_TIME = "2026-09-15T00:00:00.000Z";
const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "9b2f4ec9-302a-4f08-95c4-3bfb9236fc2d";

function fixedNow(): Date {
  return new Date(FIXED_TIME);
}

function captureLogger(uuid = UUID_A) {
  const lines: string[] = [];
  const logger = createPrivacyLogger({
    now: fixedNow,
    uuid: () => uuid,
    sink: (line) => {
      lines.push(line);
    },
  });

  return { logger, lines };
}

describe("createPrivacyLogger", () => {
  it("emits one deterministic JSON line with safe fields only", () => {
    const { logger, lines } = captureLogger();
    const correlationId = logger.createCorrelationId();

    const record = logger.log({
      level: "info",
      event: "provider_request",
      component: "correction",
      outcome: "completed",
      provider: "correction",
      code: "app_ready",
      correlationId,
      durationMs: 42,
      itemCount: 2,
      byteCount: 512,
      attempt: 0,
      retryable: false,
    });

    const expected: PrivacyLogRecord = {
      schemaVersion: 1,
      timestamp: FIXED_TIME,
      level: "info",
      event: "provider_request",
      component: "correction",
      outcome: "completed",
      provider: "correction",
      code: "app_ready",
      correlationId,
      durationMs: 42,
      itemCount: 2,
      byteCount: 512,
      attempt: 0,
      retryable: false,
    };

    assert.deepEqual(record, expected);
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      `{"schemaVersion":1,"timestamp":"${FIXED_TIME}","level":"info","event":"provider_request","component":"correction","outcome":"completed","provider":"correction","code":"app_ready","correlationId":"ec-${UUID_A}","durationMs":42,"itemCount":2,"byteCount":512,"attempt":0,"retryable":false}\n`,
    );
  });

  it("never emits private caller payloads", () => {
    const { logger, lines } = captureLogger();
    const secrets = [
      "raw-transcript-marker",
      "corrected-text-marker",
      "prompt-marker",
      "token-marker",
      "client-secret-marker",
      "person@example.test",
      "https://private.example.test/session/secret",
      "raw-session-id-marker",
      "provider-request-id-marker",
      "arbitrary-uuid-marker",
      "error-message-marker",
      "error-stack-marker",
      "nested-provider-payload-marker",
    ];
    const providerError = new Error(secrets[10]);
    providerError.stack = secrets[11];

    logger.log({
      level: "error",
      event: "provider_request",
      component: "correction",
      outcome: "failed",
      provider: "correction",
      code: "provider_request_error",
      transcript: secrets[0],
      correctedText: secrets[1],
      prompt: secrets[2],
      token: secrets[3],
      clientSecret: secrets[4],
      email: secrets[5],
      url: secrets[6],
      sessionId: secrets[7],
      providerRequestId: secrets[8],
      correlationId: `ec-${UUID_B}-${secrets[9]}`,
      error: providerError,
      providerPayload: { text: secrets[12] },
    });

    const output = lines.join("");
    for (const secret of secrets) {
      assert.equal(output.includes(secret), false, `leaked ${secret}`);
    }

    assert.deepEqual(JSON.parse(lines[0] ?? "") as unknown, {
      schemaVersion: 1,
      timestamp: FIXED_TIME,
      level: "error",
      event: "provider_request",
      component: "correction",
      outcome: "failed",
      provider: "correction",
      code: "provider_request_error",
    });
  });

  it("replaces malicious values in allowlisted string fields", () => {
    const { logger, lines } = captureLogger();
    const marker = "malicious-value-marker";

    const record = logger.log({
      level: `error\n${marker}`,
      event: `provider_request\n${marker}`,
      component: `audio\n${marker}`,
      outcome: `failed\n${marker}`,
      provider: `palabra\n${marker}`,
      code: `provider_timeout\n${marker}`,
    });

    assert.deepEqual(record, {
      schemaVersion: 1,
      timestamp: FIXED_TIME,
      level: "info",
      event: "invalid_event",
      component: "unknown",
      outcome: "unknown",
      code: "unrecognized_error",
    });
    assert.equal(lines[0]?.includes(marker), false);
  });

  it("logs only correlation IDs issued by the same logger", () => {
    const first = captureLogger(UUID_A);
    const second = captureLogger(UUID_B);
    const foreignId = first.logger.createCorrelationId();

    const foreignRecord = second.logger.log({
      event: "pipeline",
      correlationId: foreignId,
    });
    const arbitraryRecord = second.logger.log({
      event: "pipeline",
      correlationId: `ec-${UUID_B}`,
    });

    assert.equal("correlationId" in foreignRecord, false);
    assert.equal("correlationId" in arbitraryRecord, false);
  });

  it("never evaluates getters on unknown fields", () => {
    const { logger } = captureLogger();
    let getterCalls = 0;
    const fields: Record<string, unknown> = {
      level: "info",
      event: "pipeline",
    };

    for (const key of ["transcript", "token", "email", "url", "error"]) {
      Object.defineProperty(fields, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("unknown-getter-marker");
        },
      });
    }

    assert.doesNotThrow(() => logger.log(fields as PrivacyLogFields));
    assert.equal(getterCalls, 0);
  });

  it("handles throwing getters on known fields without leaking", () => {
    const { logger, lines } = captureLogger();
    const fields: Record<string, unknown> = {};

    for (const key of [
      "level",
      "event",
      "component",
      "durationMs",
      "retryable",
    ]) {
      Object.defineProperty(fields, key, {
        enumerable: true,
        get() {
          throw new Error("known-getter-secret-marker");
        },
      });
    }

    assert.doesNotThrow(() => logger.log(fields as PrivacyLogFields));
    assert.deepEqual(JSON.parse(lines[0] ?? "") as unknown, {
      schemaVersion: 1,
      timestamp: FIXED_TIME,
      level: "info",
      event: "invalid_event",
    });
    assert.equal(lines[0]?.includes("known-getter-secret-marker"), false);
  });

  it("omits negative, fractional, infinite, and unsafe numbers", () => {
    const { logger } = captureLogger();

    const record = logger.log({
      event: "pipeline",
      durationMs: -1,
      itemCount: 1.5,
      byteCount: Number.POSITIVE_INFINITY,
      attempt: Number.MAX_SAFE_INTEGER + 1,
      retryable: "true",
    });

    assert.deepEqual(record, {
      schemaVersion: 1,
      timestamp: FIXED_TIME,
      level: "info",
      event: "pipeline",
    });
  });

  it("swallows sink failures", () => {
    const logger = createPrivacyLogger({
      now: fixedNow,
      sink: () => {
        throw new Error("sink-secret-marker");
      },
    });

    assert.doesNotThrow(() =>
      logger.log({ level: "warn", event: "app_lifecycle" }),
    );
  });

  it("uses a fixed safe error for invalid UUID sources", () => {
    const invalidLoggers = [
      createPrivacyLogger({
        uuid: () => "invalid-uuid-secret-marker",
        sink: () => undefined,
      }),
      createPrivacyLogger({
        uuid: () => {
          throw new Error("uuid-source-secret-marker");
        },
        sink: () => undefined,
      }),
    ];

    for (const logger of invalidLoggers) {
      assert.throws(
        () => logger.createCorrelationId(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "privacy_logger_invalid_uuid");
          assert.equal(error.message.includes("secret-marker"), false);
          return true;
        },
      );
    }
  });
});
