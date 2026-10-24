// Keyword research agent: SEO keyword ideas with Google search volume, CPC and keyword difficulty, plus a
// Google Trends check on the best picks, paid per call with x402 (no API key, no signup).
//
// For every seed keyword it makes:
//   1 x POST https://keywords.duoleads.com/v1/keyword-ideas  ($0.04): up to --ideas related keywords, each with
//       monthly search volume, CPC, competition, keyword difficulty and intent (Google Ads data);
//   N x GET  https://keywords.duoleads.com/v1/trend          ($0.045 each): Google Trends interest over the past
//       12 months for the N best ideas (--trends, default 1), to see if demand is rising or falling.
// It ranks ideas by "opportunity" = volume / (difficulty + 10), keeping only ideas with at least --min-volume
// monthly searches and at most --max-difficulty difficulty, and prints a short plan you can act on.
//
// COST, stated upfront: per seed $0.04 + trends x $0.045. The default (1 seed, 1 trend) is $0.085.
// The run refuses to start when the plan costs more than DUO_MAX_SPEND_USD (default $0.25).
// An answer of "nothing was charged" (upstream failed) costs nothing.
// Run with --dry-run first: it prints the plan and spends nothing.
//
//   npx tsx agent.ts --dry-run "seo api"
//   DUO_PAYER_KEY=0x... npx tsx agent.ts "seo api" "rank tracker" --country us --ideas 30 --trends 2
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { createKeywordsClient, DuoApiError, SDK_USER_AGENT, type KeywordMetrics, type KeywordsClient } from "duo-data-utilities";

/** Prices in USD (https://keywords.duoleads.com/docs). */
export const IDEAS_PRICE_USD = 0.04;
export const TREND_PRICE_USD = 0.045;

export interface ResearchOptions {
  seeds: string[];
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Ideas requested per seed (1-100; the price is the same). */
  ideas: number;
  /** Google Trends checks per seed (paid, $0.045 each). */
  trends: number;
  minVolume: number;
  maxDifficulty: number;
}

export const DEFAULTS: Omit<ResearchOptions, "seeds"> = { country: "us", ideas: 20, trends: 1, minVolume: 100, maxDifficulty: 60 };

/** One planned paid call. */
export interface PlannedCall {
  route: "/v1/keyword-ideas" | "/v1/trend";
  seed: string;
  priceUsd: number;
}

/** The most this run can cost: one ideas call per seed and up to `trends` trend calls per seed. */
export function plan(options: ResearchOptions): { calls: PlannedCall[]; maxCostUsd: number } {
  const calls: PlannedCall[] = [];
  for (const seed of options.seeds) {
    calls.push({ route: "/v1/keyword-ideas", seed, priceUsd: IDEAS_PRICE_USD });
    for (let i = 0; i < options.trends; i++) calls.push({ route: "/v1/trend", seed, priceUsd: TREND_PRICE_USD });
  }
  return { calls, maxCostUsd: Math.round(calls.reduce((s, c) => s + c.priceUsd, 0) * 1000) / 1000 };
}

/** Opportunity score: more searches and lower difficulty is better. null when volume is unknown. */
export function opportunity(idea: Pick<KeywordMetrics, "volume" | "difficulty">): number | null {
  if (idea.volume === null || idea.volume === undefined) return null;
  return idea.volume / ((idea.difficulty ?? 50) + 10);
}

/** Ideas that pass the filters, best opportunity first. */
export function rank(ideas: readonly KeywordMetrics[], minVolume: number, maxDifficulty: number): KeywordMetrics[] {
  return ideas
    .filter((i) => (i.volume ?? 0) >= minVolume && (i.difficulty ?? 0) <= maxDifficulty)
    .sort((a, b) => (opportunity(b) ?? 0) - (opportunity(a) ?? 0) || a.keyword.localeCompare(b.keyword));
}

/** Direction of a 0-100 Google Trends series: last quarter of points against the first quarter. */
export function direction(series: ReadonlyArray<{ value: number; partial?: boolean }>): "rising" | "falling" | "flat" | "unknown" {
  const full = series.filter((p) => !p.partial);
  if (full.length < 4) return "unknown";
  const q = Math.max(1, Math.floor(full.length / 4));
  const avg = (xs: ReadonlyArray<{ value: number }>) => xs.reduce((s, p) => s + p.value, 0) / xs.length;
  const first = avg(full.slice(0, q));
  const last = avg(full.slice(-q));
  if (first === 0) return last > 0 ? "rising" : "flat";
  const change = (last - first) / first;
  return change > 0.15 ? "rising" : change < -0.15 ? "falling" : "flat";
}

export interface RankedKeyword extends KeywordMetrics {
  score: number | null;
  trend?: "rising" | "falling" | "flat" | "unknown";
}

export interface SeedReport {
  seed: string;
  ideasReturned: number;
  picks: RankedKeyword[];
  paidCalls: number;
  spentUsd: number;
}

/** Researches one seed. Upstream failures (5xx, "nothing was charged") are skipped and not counted as paid. */
export async function researchSeed(client: KeywordsClient, seed: string, options: Omit<ResearchOptions, "seeds">): Promise<SeedReport> {
  const ideas = await client.keywordIdeas({ keyword: seed, limit: options.ideas, country: options.country });
  let paidCalls = 1;
  let spent = IDEAS_PRICE_USD;
  const picks: RankedKeyword[] = rank(ideas.results, options.minVolume, options.maxDifficulty).map((i) => ({ ...i, score: opportunity(i) }));
  for (const pick of picks.slice(0, options.trends)) {
    try {
      const t = await client.trend({ keyword: pick.keyword, country: options.country, timeframe: "past_12_months" });
      pick.trend = direction(t.series);
      paidCalls++;
      spent += TREND_PRICE_USD;
    } catch (error) {
      if (error instanceof DuoApiError && error.status >= 500) pick.trend = "unknown";
      else throw error;
    }
  }
  return { seed, ideasReturned: ideas.results.length, picks, paidCalls, spentUsd: Math.round(spent * 1000) / 1000 };
}

export function parseArgs(argv: readonly string[]): ResearchOptions & { dryRun: boolean } {
  const options = { ...DEFAULTS, seeds: [] as string[], dryRun: false };
  const numeric: Record<string, "ideas" | "trends" | "minVolume" | "maxDifficulty"> = {
    "--ideas": "ideas",
    "--trends": "trends",
    "--min-volume": "minVolume",
    "--max-difficulty": "maxDifficulty",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--country") options.country = argv[++i] ?? "";
    else if (numeric[arg]) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error(`bad value for ${arg}`);
      options[numeric[arg]] = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    else options.seeds.push(arg);
  }
  if (options.seeds.length === 0) options.seeds.push("keyword research");
  if (options.ideas < 1 || options.ideas > 100) throw new Error("--ideas must be 1-100");
  if (!/^[a-z]{2}$/i.test(options.country)) throw new Error("--country must be a two-letter code, e.g. us");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const p = plan(options);
  const maxSpendUsd = Number(process.env.DUO_MAX_SPEND_USD ?? "0.25");
  console.log(`Plan: ${p.calls.length} paid calls for ${options.seeds.length} seed(s), at most $${p.maxCostUsd.toFixed(3)} in USDC on Base.`);
  for (const c of p.calls) console.log(`  ${c.route}  ${JSON.stringify(c.seed)}  $${c.priceUsd}`);
  if (options.dryRun) {
    console.log("Dry run: nothing was sent or paid.");
    return;
  }
  if (p.maxCostUsd > maxSpendUsd + 1e-9) throw new Error(`this run can cost $${p.maxCostUsd.toFixed(3)}, above DUO_MAX_SPEND_USD=$${maxSpendUsd.toFixed(2)}`);
  const key = process.env.DUO_PAYER_KEY;
  if (!key?.startsWith("0x")) throw new Error("set DUO_PAYER_KEY to the 0x-prefixed private key of a Base wallet holding a little USDC");
  // The client signs at most $0.045 per call, only on Base, only in USDC, only to the service's address.
  const client = createKeywordsClient({ account: privateKeyToAccount(key as `0x${string}`), userAgent: `${SDK_USER_AGENT} keyword-research-agent/1.0` });
  let spent = 0;
  for (const seed of options.seeds) {
    const report = await researchSeed(client, seed, options);
    spent += report.spentUsd;
    console.log(`\n${seed}: ${report.ideasReturned} ideas, ${report.picks.length} pass (volume >= ${options.minVolume}, difficulty <= ${options.maxDifficulty})`);
    for (const k of report.picks.slice(0, 10)) {
      console.log(`  ${k.keyword.padEnd(32)} vol ${String(k.volume).padStart(8)}  kd ${String(k.difficulty).padStart(3)}  cpc $${k.cpc ?? "-"}  ${k.intent ?? ""}${k.trend ? `  trend ${k.trend}` : ""}`);
    }
  }
  console.error(`\nDone: $${spent.toFixed(3)} spent.`);
}

// Run only when executed directly, so tests can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
