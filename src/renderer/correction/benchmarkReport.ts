import type {
  CorrectionErrorCode,
  CorrectionOutcome,
  CorrectionWarning,
} from "./contracts";

/** One corpus fixture measured against a real correction provider. */
export type BenchmarkRecord = {
  id: string;
  category: string;
  expectedOutcome: CorrectionOutcome;
  outcome: CorrectionOutcome;
  warnings: CorrectionWarning[];
  errorCode?: CorrectionErrorCode;
  /** Wall clock around the whole correction stage, not only the provider. */
  latencyMs: number;
  /** Provider time reported by the engine, when the engine measured it. */
  providerLatencyMs?: number;
  /**
   * Invariants re-checked on the sentence that would reach the speaker. A
   * non-empty list means something unsafe was about to be spoken.
   */
  recheckWarnings: CorrectionWarning[];
  knownLimitation?: boolean;
};

export type LatencySummary = {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type RateSummary = {
  total: number;
  matched: number;
  rate: number;
};

export type CountedItem = {
  name: string;
  count: number;
};

export type CategorySummary = {
  category: string;
  total: number;
  changed: number;
  unchanged: number;
  fallback: number;
};

export type BenchmarkSummary = {
  total: number;
  byOutcome: Record<CorrectionOutcome, number>;
  /** Fixtures with a real grammar error that the provider actually fixed. */
  grammar: RateSummary;
  /** Already correct fixtures that the provider left alone. */
  unchanged: RateSummary;
  fallbackRate: number;
  errorCodes: CountedItem[];
  warnings: CountedItem[];
  unsafeSpoken: {
    count: number;
    rate: number;
    ids: string[];
  };
  protectedTokens: RateSummary;
  latency: LatencySummary;
  providerLatency: LatencySummary;
  byCategory: CategorySummary[];
  knownLimitationIds: string[];
};

export type BenchmarkMeta = {
  modelId: string;
  baseUrl: string;
  timeoutMs: number;
  promptVersion: string;
  startedAt: string;
};

/** Nearest rank, so every number in the report is a measured sample. */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function summarizeLatency(values: number[]): LatencySummary {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1),
  };
}

function rateOf(matched: number, total: number): RateSummary {
  return { total, matched, rate: total === 0 ? 0 : matched / total };
}

function countBy(values: string[]): CountedItem[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count);
}

/** Aggregates one run. It never reports a number it did not measure. */
export function summarizeBenchmark(
  records: BenchmarkRecord[],
): BenchmarkSummary {
  const byOutcome: Record<CorrectionOutcome, number> = {
    changed: 0,
    unchanged: 0,
    fallback: 0,
  };
  const categories = new Map<string, CategorySummary>();

  for (const record of records) {
    byOutcome[record.outcome] += 1;
    const category = categories.get(record.category) ?? {
      category: record.category,
      total: 0,
      changed: 0,
      unchanged: 0,
      fallback: 0,
    };
    category.total += 1;
    category[record.outcome] += 1;
    categories.set(record.category, category);
  }

  const grammarCases = records.filter(
    (record) => record.expectedOutcome === "changed",
  );
  const unchangedCases = records.filter(
    (record) => record.expectedOutcome === "unchanged",
  );
  const unsafe = records.filter((record) => record.recheckWarnings.length > 0);
  const tokensKept = records.filter(
    (record) =>
      !record.recheckWarnings.includes("name_changed") &&
      !record.recheckWarnings.includes("number_changed"),
  );

  return {
    total: records.length,
    byOutcome,
    grammar: rateOf(
      grammarCases.filter((record) => record.outcome === "changed").length,
      grammarCases.length,
    ),
    unchanged: rateOf(
      unchangedCases.filter((record) => record.outcome === "unchanged").length,
      unchangedCases.length,
    ),
    fallbackRate:
      records.length === 0 ? 0 : byOutcome.fallback / records.length,
    errorCodes: countBy(
      records
        .map((record) => record.errorCode)
        .filter((code): code is CorrectionErrorCode => code !== undefined),
    ),
    warnings: countBy(records.flatMap((record) => record.warnings)),
    unsafeSpoken: {
      count: unsafe.length,
      rate: records.length === 0 ? 0 : unsafe.length / records.length,
      ids: unsafe.map((record) => record.id),
    },
    protectedTokens: rateOf(tokensKept.length, records.length),
    latency: summarizeLatency(records.map((record) => record.latencyMs)),
    providerLatency: summarizeLatency(
      records
        .map((record) => record.providerLatencyMs)
        .filter((value): value is number => value !== undefined),
    ),
    byCategory: [...categories.values()],
    knownLimitationIds: records
      .filter((record) => record.knownLimitation === true)
      .map((record) => record.id),
  };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function duration(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function row(label: string, value: string): string {
  return value.length === 0 ? label : `${label.padEnd(32)}${value}`;
}

/** Plain text report, meant to be pasted into the epic page as measured. */
export function formatBenchmarkReport(
  summary: BenchmarkSummary,
  meta: BenchmarkMeta,
): string {
  const lines: string[] = [];

  function add(label: string, value: string): void {
    lines.push(row(label, value));
  }

  lines.push("Correction benchmark", "");
  add("Model", meta.modelId);
  add("Base URL", meta.baseUrl);
  add("Timeout", `${meta.timeoutMs} ms`);
  add("Prompt version", meta.promptVersion);
  add("Started at", meta.startedAt);
  add("Fixtures", String(summary.total));

  lines.push("", "Quality");
  add(
    "  Grammar pass rate",
    `${percent(summary.grammar.rate)} (${summary.grammar.matched}/${summary.grammar.total})`,
  );
  add(
    "  Unchanged accuracy",
    `${percent(summary.unchanged.rate)} (${summary.unchanged.matched}/${summary.unchanged.total})`,
  );
  add("  Fallback rate", percent(summary.fallbackRate));
  add(
    "  Protected tokens kept",
    `${percent(summary.protectedTokens.rate)} (${summary.protectedTokens.matched}/${summary.protectedTokens.total})`,
  );
  add(
    "  Unsafe sentences spoken",
    `${summary.unsafeSpoken.count} (${percent(summary.unsafeSpoken.rate)})`,
  );

  lines.push("", "Latency");
  add("  Correction stage median", duration(summary.latency.medianMs));
  add("  Correction stage P95", duration(summary.latency.p95Ms));
  add("  Correction stage max", duration(summary.latency.maxMs));
  add("  Provider median", duration(summary.providerLatency.medianMs));
  add("  Provider P95", duration(summary.providerLatency.p95Ms));

  lines.push("", "Outcomes");
  add("  changed", String(summary.byOutcome.changed));
  add("  unchanged", String(summary.byOutcome.unchanged));
  add("  fallback", String(summary.byOutcome.fallback));

  lines.push("", "Fallback error codes");
  if (summary.errorCodes.length === 0) lines.push("  none");
  for (const item of summary.errorCodes) {
    add(`  ${item.name}`, String(item.count));
  }

  lines.push("", "Warnings raised");
  if (summary.warnings.length === 0) lines.push("  none");
  for (const item of summary.warnings) {
    add(`  ${item.name}`, String(item.count));
  }

  lines.push("", "By category");
  for (const item of summary.byCategory) {
    add(
      `  ${item.category}`,
      `${item.total} total, ${item.changed} changed, ${item.unchanged} unchanged, ${item.fallback} fallback`,
    );
  }

  if (summary.unsafeSpoken.ids.length > 0) {
    lines.push("", `Unsafe fixtures: ${summary.unsafeSpoken.ids.join(", ")}`);
  }
  if (summary.knownLimitationIds.length > 0) {
    lines.push(
      "",
      `Known limitations: ${summary.knownLimitationIds.join(", ")}`,
    );
  }

  return lines.join("\n");
}
