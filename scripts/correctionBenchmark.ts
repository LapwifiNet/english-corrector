import { writeFileSync } from "node:fs";
import {
  readCorrectionProviderStatus,
  readCorrectionRuntimeConfig,
  requestCorrection,
} from "../src/main/correctionClient";
import {
  formatBenchmarkReport,
  summarizeBenchmark,
  type BenchmarkRecord,
} from "../src/renderer/correction/benchmarkReport";
import type { CorrectionAdapter } from "../src/renderer/correction/contracts";
import {
  CORRECTION_CORPUS,
  type CorpusFixture,
} from "../src/renderer/correction/correctionCorpus";
import { createCorrectionEngine } from "../src/renderer/correction/correctionEngine";
import { validateCorrection } from "../src/renderer/correction/invariantValidators";
import { extractProtectedTokens } from "../src/renderer/correction/protectedTokens";

const USAGE = `Usage: npm run bench:correction -- [options]

Options:
  --limit=<n>        Run only the first n fixtures.
  --category=<name>  Run only fixtures from one category.
  --ids=<a,b,c>      Run only these fixture ids.
  --delay=<ms>       Wait between calls to stay inside a rate limit.
  --out=<path>       Write the raw records and the summary as JSON.
  --help             Print this message.

Required environment: CORRECTION_API_KEY.
Optional: CORRECTION_BASE_URL, CORRECTION_MODEL_ID, CORRECTION_TIMEOUT_MS.`;

type Options = {
  help: boolean;
  limit: number | null;
  category: string | null;
  ids: Set<string> | null;
  delayMs: number;
  out: string | null;
};

function readInteger(value: string, fallback: number | null): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    help: false,
    limit: null,
    category: null,
    ids: null,
    delayMs: 0,
    out: null,
  };

  for (const argument of argv) {
    const separator = argument.indexOf("=");
    const key = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? "" : argument.slice(separator + 1);

    switch (key) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--limit":
        options.limit = readInteger(value, null);
        break;
      case "--delay":
        options.delayMs = readInteger(value, 0) ?? 0;
        break;
      case "--category":
        options.category = value.trim() || null;
        break;
      case "--out":
        options.out = value.trim() || null;
        break;
      case "--ids": {
        const ids = value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        options.ids = ids.length > 0 ? new Set(ids) : null;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function selectFixtures(options: Options): CorpusFixture[] {
  let fixtures: CorpusFixture[] = [...CORRECTION_CORPUS];
  const ids = options.ids;
  if (ids) {
    fixtures = fixtures.filter((fixture) => ids.has(fixture.id));
  }
  if (options.category) {
    const category = options.category.toLowerCase();
    fixtures = fixtures.filter(
      (fixture) => fixture.category.toLowerCase() === category,
    );
  }
  if (options.limit !== null) {
    fixtures = fixtures.slice(0, options.limit);
  }
  return fixtures;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the curated corpus against the configured provider and prints the
 * measured quality and latency numbers. Fixture text is public test data, so
 * the run prints fixture ids and outcomes but never the API key.
 */
async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const status = readCorrectionProviderStatus();
  const config = readCorrectionRuntimeConfig();
  if (!config) {
    console.error(`Missing configuration: ${status.missing.join(", ")}`);
    console.error(USAGE);
    return 1;
  }

  const fixtures = selectFixtures(options);
  if (fixtures.length === 0) {
    console.error("No fixture matched the filters.");
    return 1;
  }

  const adapter: CorrectionAdapter = {
    name: "benchmark",
    correct: (request, signal) =>
      requestCorrection({
        request: {
          phraseId: request.phraseId,
          originalText: request.originalText,
        },
        config,
        signal: signal ?? new AbortController().signal,
      }),
  };
  const engine = createCorrectionEngine({
    adapter,
    timeoutMs: config.timeoutMs,
  });

  const startedAt = new Date().toISOString();
  const records: BenchmarkRecord[] = [];
  let promptVersion = "unknown";

  for (const fixture of fixtures) {
    const begunAt = Date.now();
    const result = await engine.correct({
      phraseId: fixture.id,
      originalText: fixture.input,
      locale: "en",
    });
    const latencyMs = Date.now() - begunAt;
    promptVersion = result.promptVersion;

    const recheckWarnings = validateCorrection(
      result.originalText,
      result.correctedText,
      extractProtectedTokens(result.originalText),
    );

    records.push({
      id: fixture.id,
      category: fixture.category,
      expectedOutcome: fixture.expectedOutcome,
      outcome: result.outcome,
      warnings: result.warnings,
      errorCode: result.errorCode,
      latencyMs,
      providerLatencyMs: result.providerLatencyMs,
      recheckWarnings,
      knownLimitation: fixture.knownLimitation,
    });

    const detail = result.errorCode ?? result.warnings.join(",");
    console.error(
      `${fixture.id.padEnd(8)}${result.outcome.padEnd(10)}${String(latencyMs).padStart(5)} ms  ${detail}`,
    );

    if (options.delayMs > 0) await sleep(options.delayMs);
  }

  const summary = summarizeBenchmark(records);
  const meta = {
    modelId: config.modelId,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    promptVersion,
    startedAt,
  };

  console.log("");
  console.log(formatBenchmarkReport(summary, meta));

  if (options.out) {
    writeFileSync(
      options.out,
      `${JSON.stringify({ meta, summary, records }, null, 2)}\n`,
    );
    console.error(`Wrote ${options.out}`);
  }

  return summary.unsafeSpoken.count === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
