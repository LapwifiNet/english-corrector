import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatBenchmarkReport,
  percentile,
  summarizeBenchmark,
  type BenchmarkMeta,
  type BenchmarkRecord,
} from "./benchmarkReport";

const META: BenchmarkMeta = {
  modelId: "test-model",
  baseUrl: "https://example.test/v1",
  timeoutMs: 1500,
  promptVersion: "correction-v1",
  startedAt: "2026-09-14T12:00:00.000Z",
};

function record(overrides: Partial<BenchmarkRecord> = {}): BenchmarkRecord {
  return {
    id: "agr-01",
    category: "subject-verb agreement",
    expectedOutcome: "changed",
    outcome: "changed",
    warnings: [],
    latencyMs: 100,
    recheckWarnings: [],
    ...overrides,
  };
}

describe("percentile", () => {
  it("returns null for an empty sample", () => {
    assert.equal(percentile([], 0.5), null);
  });

  it("uses the nearest rank instead of interpolating", () => {
    assert.equal(percentile([400, 100, 300, 200], 0.5), 200);
    assert.equal(percentile([100, 200, 300, 400, 500], 0.95), 500);
    assert.equal(percentile([100, 200, 300, 400, 500], 1), 500);
  });
});

describe("summarizeBenchmark", () => {
  it("separates grammar pass rate from unchanged accuracy", () => {
    const summary = summarizeBenchmark([
      record({ id: "agr-01", outcome: "changed" }),
      record({
        id: "agr-02",
        outcome: "fallback",
        errorCode: "invalid_output",
      }),
      record({
        id: "ok-01",
        category: "already correct",
        expectedOutcome: "unchanged",
        outcome: "unchanged",
      }),
    ]);

    assert.deepEqual(summary.grammar, { total: 2, matched: 1, rate: 0.5 });
    assert.deepEqual(summary.unchanged, { total: 1, matched: 1, rate: 1 });
    assert.equal(summary.byOutcome.fallback, 1);
    assert.deepEqual(summary.errorCodes, [
      { name: "invalid_output", count: 1 },
    ]);
    assert.equal(Math.round(summary.fallbackRate * 100), 33);
  });

  it("counts a spoken sentence that broke an invariant as unsafe", () => {
    const summary = summarizeBenchmark([
      record({ id: "nam-01", recheckWarnings: ["name_changed"] }),
      record({ id: "num-01", recheckWarnings: ["number_changed"] }),
      record({ id: "agr-01" }),
    ]);

    assert.equal(summary.unsafeSpoken.count, 2);
    assert.deepEqual(summary.unsafeSpoken.ids, ["nam-01", "num-01"]);
    assert.deepEqual(summary.protectedTokens, {
      total: 3,
      matched: 1,
      rate: 1 / 3,
    });
  });

  it("groups fixtures by category and keeps latency samples apart", () => {
    const summary = summarizeBenchmark([
      record({ latencyMs: 200, providerLatencyMs: 150 }),
      record({
        id: "art-01",
        category: "articles",
        latencyMs: 400,
        providerLatencyMs: 350,
      }),
    ]);

    assert.deepEqual(summary.byCategory, [
      {
        category: "subject-verb agreement",
        total: 1,
        changed: 1,
        unchanged: 0,
        fallback: 0,
      },
      {
        category: "articles",
        total: 1,
        changed: 1,
        unchanged: 0,
        fallback: 0,
      },
    ]);
    assert.equal(summary.latency.medianMs, 200);
    assert.equal(summary.providerLatency.medianMs, 150);
  });
});

describe("formatBenchmarkReport", () => {
  it("reports the measured numbers and the model that produced them", () => {
    const summary = summarizeBenchmark([
      record({ latencyMs: 250, providerLatencyMs: 200 }),
      record({
        id: "ok-01",
        expectedOutcome: "unchanged",
        outcome: "unchanged",
        latencyMs: 150,
      }),
    ]);

    const report = formatBenchmarkReport(summary, META);

    assert.match(report, /Model\s+test-model/);
    assert.match(report, /Grammar pass rate\s+100\.0% \(1\/1\)/);
    assert.match(report, /Correction stage median\s+150 ms/);
    assert.match(report, /Provider median\s+200 ms/);
    assert.match(report, /Warnings raised\n {2}none/);
  });
});
