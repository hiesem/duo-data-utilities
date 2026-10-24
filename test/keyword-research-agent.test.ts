// examples/keyword-research-agent runs offline here: the keyword client gets a fake fetch. Nothing touches the
// network and nothing is paid. The expected values below were worked out by hand from the fixture.
import { describe, expect, it } from "vitest";
import { createKeywordsClient } from "../src/index.js";
import { direction, opportunity, parseArgs, plan, rank, researchSeed, DEFAULTS } from "../examples/keyword-research-agent/agent.js";
import { jsonResponse } from "./helpers/challenge.js";

const idea = (keyword: string, volume: number | null, difficulty: number | null) => ({
  keyword,
  volume,
  cpc: 1.5,
  competition: 0.5,
  competitionLevel: "MEDIUM",
  difficulty,
  intent: "commercial",
  trendYoyPct: 0,
});

// Opportunity = volume / (difficulty + 10):
//   "rank tracker api" 500 / (0 + 10)  = 50       -> 1st
//   "seo api"          1000 / (20 + 10) = 33.3     -> 2nd
//   "serp api"         difficulty 70 > 60           -> filtered out
//   "seo api free"     volume 50 < 100              -> filtered out
//   "keyword api"      volume unknown (null)        -> filtered out
const IDEAS = {
  seed: "seo api",
  total: 5,
  results: [idea("seo api", 1000, 20), idea("serp api", 5000, 70), idea("rank tracker api", 500, 0), idea("seo api free", 50, 5), idea("keyword api", null, 10)],
  available: 5,
  market: { locationCode: 2840, locationName: "United States", country: "US", languageCode: "en", fallback: false },
};
// 8 full weeks plus 1 partial: first quarter (2 points) averages 10, last quarter 40 -> +300% -> rising.
const RISING = [10, 10, 20, 20, 30, 30, 40, 40].map((value, i) => ({ date: `2026-0${1 + Math.floor(i / 4)}-0${1 + (i % 4)}`, value }));
const TREND = { keyword: "rank tracker api", country: "US", timeframe: "past_12_months", granularity: "week", series: [...RISING, { date: "2026-10-11", value: 0, partial: true }] };

function fakeClient(trendStatus = 200) {
  const seen: Array<{ method: string; path: string; search: string; body: string | undefined }> = [];
  const client = createKeywordsClient({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, body: init?.body as string | undefined });
      if (url.pathname === "/v1/keyword-ideas") return jsonResponse(IDEAS);
      if (trendStatus !== 200) return jsonResponse({ error: { status: trendStatus, code: "UPSTREAM_UNAVAILABLE", message: "nothing was charged" } }, { status: trendStatus });
      return jsonResponse(TREND);
    },
  });
  return { client, seen };
}

describe("examples/keyword-research-agent", () => {
  it("plans one ideas call plus `trends` trend calls per seed, with the cost stated upfront", () => {
    const one = plan({ ...DEFAULTS, seeds: ["seo api"] });
    expect(one.calls.map((c) => c.route)).toEqual(["/v1/keyword-ideas", "/v1/trend"]);
    expect(one.maxCostUsd).toBe(0.085); // 0.04 + 0.045
    expect(plan({ ...DEFAULTS, seeds: ["a", "b"], trends: 2 }).maxCostUsd).toBe(0.26); // 2 x (0.04 + 2 x 0.045)
    expect(plan({ ...DEFAULTS, seeds: ["a"], trends: 0 }).maxCostUsd).toBe(0.04);
  });

  it("ranks by volume relative to difficulty and drops ideas outside the filters", () => {
    expect(opportunity({ volume: 1000, difficulty: 20 })).toBeCloseTo(33.333, 3);
    expect(opportunity({ volume: null, difficulty: 10 })).toBeNull();
    expect(rank(IDEAS.results, 100, 60).map((i) => i.keyword)).toEqual(["rank tracker api", "seo api"]);
  });

  it("reads a Google Trends series as rising, falling, flat or unknown", () => {
    expect(direction(TREND.series)).toBe("rising");
    expect(direction([80, 80, 40, 40].map((value) => ({ value })))).toBe("falling"); // 80 -> 40 = -50%
    expect(direction([50, 52, 48, 50].map((value) => ({ value })))).toBe("flat"); // 50 -> 50
    expect(direction([10, 20, 30].map((value) => ({ value })))).toBe("unknown"); // fewer than 4 full points
  });

  it("researches a seed with 2 paid calls ($0.085): ideas, then a trend for the best pick", async () => {
    const { client, seen } = fakeClient();
    const report = await researchSeed(client, "seo api", { ...DEFAULTS, country: "gb" });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/keyword-ideas", "GET /v1/trend"]);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ keyword: "seo api", limit: 20, country: "gb" });
    expect(seen[1]?.search).toBe("?keyword=rank+tracker+api&country=gb&timeframe=past_12_months");
    expect(report.picks.map((p) => [p.keyword, p.trend])).toEqual([
      ["rank tracker api", "rising"],
      ["seo api", undefined],
    ]);
    expect(report.picks[0]?.score).toBe(50);
    expect(report).toMatchObject({ seed: "seo api", ideasReturned: 5, paidCalls: 2, spentUsd: 0.085 });
  });

  it("does not count a trend call the service answered with 'nothing was charged'", async () => {
    const { client } = fakeClient(503);
    const report = await researchSeed(client, "seo api", DEFAULTS);
    expect(report.picks[0]?.trend).toBe("unknown");
    expect(report).toMatchObject({ paidCalls: 1, spentUsd: 0.04 });
  });

  it("parses seeds and flags", () => {
    expect(parseArgs(["--dry-run", "seo api", "rank tracker", "--country", "gb", "--ideas", "50", "--trends", "2"])).toMatchObject({
      dryRun: true,
      seeds: ["seo api", "rank tracker"],
      country: "gb",
      ideas: 50,
      trends: 2,
    });
    expect(parseArgs([]).seeds).toEqual(["keyword research"]);
    expect(() => parseArgs(["--ideas", "101"])).toThrow(/1-100/);
    expect(() => parseArgs(["--country", "usa"])).toThrow(/two-letter/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });
});
