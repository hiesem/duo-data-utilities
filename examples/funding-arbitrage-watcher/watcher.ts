// Funding rate arbitrage watcher for perpetual futures (perp funding across 8 exchanges).
//
// Every interval it calls GET https://derivs.duoleads.com/v1/funding-arbitrage once: for every coin the
// widest cross-venue perp funding spread on Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and
// OKX, with the long and short venue, fee-adjusted net APR and breakeven days. It prints each opportunity
// the first time it clears your net-APR threshold (and again when it moves to another venue pair).
// Data only, not investment advice.
//
// COST, stated upfront: $0.005 per scan, paid in USDC on Base via x402 from YOUR wallet (DUO_PAYER_KEY).
// The default run is 12 scans, one every 5 minutes (one hour): 12 x $0.005 = $0.06.
// A scan that the service answers with "nothing was charged" (too few venues) costs nothing.
// The run refuses to start when scans x $0.005 is above DUO_MAX_SPEND_USD (default $0.10).
// Run with --dry-run first: it prints the plan and spends nothing.
//
//   npx tsx watcher.ts --dry-run
//   DUO_PAYER_KEY=0x... npx tsx watcher.ts --scans 12 --interval-min 5 --min-net-apr 20 --min-volume-usd 1000000
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { createDerivsClient, DuoApiError, SDK_USER_AGENT, type DerivsClient, type DerivsFundingArbitrageData } from "duo-data-utilities";

/** Price of one /v1/funding-arbitrage call in USD. */
export const PRICE_USD = 0.005;

export interface WatchOptions {
  /** Number of scans (paid calls). */
  scans: number;
  /** Minutes between scans. */
  intervalMin: number;
  /** Alert threshold: fee-adjusted net APR in percent. */
  minNetApr: number;
  /** Both legs need at least this 24 h volume in USD (server-side liquidity filter). */
  minVolumeUsd: number;
  /** Taker fee per fill in percent, used by the server for net APR. */
  feePct: number;
  /** Holding period in days, used by the server to amortise fees. */
  holdingDays: number;
}

export const DEFAULTS: WatchOptions = { scans: 12, intervalMin: 5, minNetApr: 20, minVolumeUsd: 1_000_000, feePct: 0.05, holdingDays: 30 };

export type Opportunity = DerivsFundingArbitrageData["opportunities"][number];

export interface Alert {
  scan: number;
  coin: string;
  longVenue: string;
  shortVenue: string;
  netAprPct: number;
  grossAprPct: number;
  breakevenDays: number | null;
}

/** The plan and its maximum cost, before anything is paid. */
export function plan(options: WatchOptions): { calls: number; maxCostUsd: number; durationMin: number } {
  return { calls: options.scans, maxCostUsd: options.scans * PRICE_USD, durationMin: Math.max(0, options.scans - 1) * options.intervalMin };
}

/** Opportunities at or above the threshold that were not alerted yet (key: coin + long venue + short venue). */
export function freshAlerts(seen: Set<string>, opportunities: readonly Opportunity[], minNetApr: number, scan: number): Alert[] {
  const alerts: Alert[] = [];
  for (const o of opportunities) {
    if (o.net_apr_pct === null || o.net_apr_pct < minNetApr) continue;
    const key = `${o.coin}|${o.long.venue}|${o.short.venue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alerts.push({
      scan,
      coin: o.coin,
      longVenue: o.long.venue,
      shortVenue: o.short.venue,
      netAprPct: o.net_apr_pct,
      grossAprPct: o.gross_apr_pct ?? 0,
      breakevenDays: o.breakeven_days,
    });
  }
  return alerts;
}

export interface WatchResult {
  scans: number;
  /** Scans that returned data (paid). */
  paidScans: number;
  alerts: Alert[];
  spentUsd: number;
}

/** Runs the watch loop. `sleep` and `log` are injectable so the loop can be tested offline. */
export async function runWatcher(
  client: DerivsClient,
  options: WatchOptions,
  deps: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<WatchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));
  const seen = new Set<string>();
  const alerts: Alert[] = [];
  let paidScans = 0;
  for (let scan = 1; scan <= options.scans; scan++) {
    try {
      const result = await client.fundingArbitrage({
        min_apr: options.minNetApr,
        min_volume_usd: options.minVolumeUsd,
        fee_pct: options.feePct,
        holding_days: options.holdingDays,
        limit: 50,
      });
      paidScans++;
      const fresh = freshAlerts(seen, result.opportunities, options.minNetApr, scan);
      alerts.push(...fresh);
      log(`[scan ${scan}/${options.scans}] ${result.as_of ?? ""} ${result.coins_scanned} coins, ${result.count} spreads >= ${options.minNetApr}% gross, ${fresh.length} new`);
      for (const a of fresh) {
        log(`  ${a.coin}: long ${a.longVenue} / short ${a.shortVenue}  net ${a.netAprPct.toFixed(1)}% APR (gross ${a.grossAprPct.toFixed(1)}%), breakeven ${a.breakevenDays === null ? "n/a" : `${a.breakevenDays.toFixed(2)} d`}`);
      }
      if (result.venues_missing.length > 0) log(`  venues missing: ${result.venues_missing.map((m) => `${m.venue} (${m.reason})`).join(", ")}`);
    } catch (error) {
      // A 503 "nothing was charged" (too few venues) is not paid; log it and keep watching.
      if (error instanceof DuoApiError && error.status >= 500) log(`[scan ${scan}/${options.scans}] skipped: ${error.message}`);
      else throw error;
    }
    if (scan < options.scans) await sleep(options.intervalMin * 60_000);
  }
  return { scans: options.scans, paidScans, alerts, spentUsd: paidScans * PRICE_USD };
}

export function parseArgs(argv: readonly string[]): WatchOptions & { dryRun: boolean } {
  const options = { ...DEFAULTS, dryRun: false };
  const numeric: Record<string, keyof WatchOptions> = {
    "--scans": "scans",
    "--interval-min": "intervalMin",
    "--min-net-apr": "minNetApr",
    "--min-volume-usd": "minVolumeUsd",
    "--fee-pct": "feePct",
    "--holding-days": "holdingDays",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = numeric[flag];
    const value = Number(argv[i + 1]);
    if (!key || !Number.isFinite(value) || value < 0) throw new Error(`unknown flag or bad value: ${flag} ${argv[i + 1] ?? ""}`);
    options[key] = value;
    i++;
  }
  if (!Number.isInteger(options.scans) || options.scans < 1) throw new Error("--scans must be a whole number >= 1");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const p = plan(options);
  const maxSpendUsd = Number(process.env.DUO_MAX_SPEND_USD ?? "0.10");
  console.log(
    `Plan: ${p.calls} scans of /v1/funding-arbitrage, one every ${options.intervalMin} min (${p.durationMin} min), at most $${p.maxCostUsd.toFixed(3)} in USDC on Base ($${PRICE_USD} per scan).`,
  );
  if (options.dryRun) {
    console.log("Dry run: nothing was sent or paid.");
    return;
  }
  if (p.maxCostUsd > maxSpendUsd + 1e-9) throw new Error(`this run can cost $${p.maxCostUsd.toFixed(3)}, above DUO_MAX_SPEND_USD=$${maxSpendUsd.toFixed(2)}`);
  const key = process.env.DUO_PAYER_KEY;
  if (!key?.startsWith("0x")) throw new Error("set DUO_PAYER_KEY to the 0x-prefixed private key of a Base wallet holding a little USDC");
  // The client signs at most $0.005 per call, only on Base, only in USDC, only to the service's address.
  const client = createDerivsClient({ account: privateKeyToAccount(key as `0x${string}`), userAgent: `${SDK_USER_AGENT} funding-arbitrage-watcher/1.0` });
  const result = await runWatcher(client, options);
  console.error(`Done: ${result.paidScans} paid scans, ${result.alerts.length} alerts, $${result.spentUsd.toFixed(3)} spent.`);
}

// Run only when executed directly, so tests can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
