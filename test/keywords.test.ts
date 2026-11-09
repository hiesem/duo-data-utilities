// The keyword client (https://keywords.duoleads.com) is tested against a loopback mock server and a fake fetch.
// Nothing touches the network and nothing is paid: the 402 challenges are mocked, and the signer is a
// throwaway account generated at run time.
// Independent authority for prices and methods: growth/PLAN-keyword-service.md FINAL v1 SCOPE, which gives
// keyword-overview, search-volume and keyword-ideas at $0.04 (40000), trend at $0.045 (45000), and
// related-queries and interest-by-region at $0.03 (30000). keyword-overview and keyword-ideas are POST with a
// JSON body; the rest are GET.
// Answer shapes are copied from the service's published output examples (src/kw/routes/*.ts OUTPUT_EXAMPLE).
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildKeywordsQuery,
  createClient,
  createKeywordsClient,
  DEFAULT_KEYWORDS_MAX_PRICE_USD,
  DuoApiError,
  KEYWORDS_MCP_URL,
  KEYWORDS_ROUTES,
  PriceGuardError,
  SDK_USER_AGENT,
  type EvmSigner,
} from "../src/index.js";
import { BASE_USDC, challengeHeader, jsonResponse, PAY_TO, paymentResponseHeader, type Challenge, type Requirement } from "./helpers/challenge.js";
import { startMockServer, type MockReply } from "./helpers/mock-server.js";

const PLAN_PRICES: Record<string, string> = {
  "/v1/keyword-overview": "40000",
  "/v1/search-volume": "40000",
  "/v1/keyword-ideas": "40000",
  "/v1/trend": "45000",
  "/v1/related-queries": "30000",
  "/v1/interest-by-region": "30000",
};

const MARKET = { locationCode: 2840, locationName: "United States", country: "US", languageCode: "en", fallback: false };
const KW_EXAMPLES: Record<string, Record<string, unknown>> = {
  "/v1/keyword-overview": {
    total: 2,
    results: [
      { keyword: "phone", volume: 673000, cpc: 4.63, competition: 0.76, competitionLevel: "HIGH", difficulty: 54, intent: "informational", trendYoyPct: 50 },
      { keyword: "watch", volume: 550000, cpc: 1.39, competition: 0.95, competitionLevel: "HIGH", difficulty: 54, intent: "transactional", trendYoyPct: 22 },
    ],
    missing: [],
    market: MARKET,
    request_id: "01KEXAMPLE0000000000000000",
  },
  "/v1/keyword-ideas": {
    seed: "phone",
    total: 2,
    results: [
      { keyword: "nothing phone", volume: 165000, cpc: 0.31, competition: 0.92, competitionLevel: "HIGH", difficulty: 31, intent: "informational", trendYoyPct: 174 },
      { keyword: "find phone", volume: 14800, cpc: 2.14, competition: 0.1, competitionLevel: "LOW", difficulty: 57, intent: "informational", trendYoyPct: 22 },
    ],
    available: 425645,
    market: MARKET,
    request_id: "01KEXAMPLE0000000000000000",
  },
  "/v1/trend": {
    keyword: "seo tools",
    country: "US",
    timeframe: "past_12_months",
    granularity: "week",
    series: [
      { date: "2025-10-05", value: 62 },
      { date: "2026-10-11", value: 11, partial: true },
    ],
    request_id: "01KEXAMPLE0000000000000000",
  },
  "/v1/related-queries": {
    keyword: "seo api",
    country: "US",
    timeframe: "past_12_months",
    top: [
      { term: "analytics seo api", value: 100 },
      { term: "moz api", value: 64 },
    ],
    rising: [],
    request_id: "01KEXAMPLE0000000000000000",
  },
  "/v1/interest-by-region": {
    keyword: "seo api",
    country: "US",
    timeframe: "past_12_months",
    resolution: "region",
    regions: [
      { region: "New York", code: "US-NY", value: 100 },
      { region: "California", code: "US-CA", value: 37 },
    ],
    request_id: "01KEXAMPLE0000000000000000",
  },
};
KW_EXAMPLES["/v1/search-volume"] = KW_EXAMPLES["/v1/keyword-overview"] as Record<string, unknown>;

const INPUTS: Record<string, object> = {
  keywordOverview: { keywords: ["phone", "watch"], locationCode: 2840, languageCode: "en" },
  searchVolume: { keywords: ["phone", "watch"], country: "us", lang: "en" },
  keywordIdeas: { keyword: "phone", limit: 2, locationCode: 2840, languageCode: "en" },
  trend: { keyword: "seo tools", country: "us", timeframe: "past_12_months" },
  relatedQueries: { keyword: "seo api", country: "us", timeframe: "past_12_months" },
  interestByRegion: { keyword: "seo api", country: "us", timeframe: "past_12_months" },
};

function spySigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signTypedData = vi.fn((message: unknown) => account.signTypedData(message as Parameters<typeof account.signTypedData>[0]));
  return { account, signer: { address: account.address, signTypedData } as unknown as EvmSigner, signTypedData };
}

function decodePaymentSignature(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepted: Requirement;
    payload: { authorization: { from: string; to: string; value: string } };
  };
}

/** A keyword PAYMENT-REQUIRED challenge: the real captured challenge with the keyword price and resource. */
function kwChallengeHeader(path: string, amount: string, edit?: (challenge: Challenge) => void): string {
  return challengeHeader((challenge) => {
    (challenge.accepts[0] as Requirement).amount = amount;
    challenge.resource = { url: `https://keywords.duoleads.com${path}`, mimeType: "application/json", serviceName: "Keyword Search Volume and CPC" };
    delete challenge.extensions;
    edit?.(challenge);
  });
}

async function kwServer(amountFor: (path: string) => string = (p) => PLAN_PRICES[p] ?? "0") {
  return startMockServer((request): MockReply => {
    if (!request.paymentSignature) return { status: 402, headers: { "PAYMENT-REQUIRED": kwChallengeHeader(request.path, amountFor(request.path)) } };
    return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(PAY_TO) }, body: KW_EXAMPLES[request.path] };
  });
}

function fakeFetch(reply: (url: URL) => Response = (url) => jsonResponse(KW_EXAMPLES[url.pathname])) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return reply(url);
  };
  return { calls, fetchImpl };
}

describe("keyword route table", () => {
  it("has the 6 routes at the plan's prices, POST only for keyword-overview and keyword-ideas", () => {
    expect(KEYWORDS_ROUTES).toHaveLength(6);
    for (const r of KEYWORDS_ROUTES) {
      expect(r.amount, r.path).toBe(PLAN_PRICES[r.path]);
      expect(Number(r.priceUsd) * 1e6).toBeCloseTo(Number(r.amount));
    }
    expect(KEYWORDS_ROUTES.filter((r) => r.httpMethod === "POST").map((r) => r.path)).toEqual(["/v1/keyword-overview", "/v1/keyword-ideas"]);
  });

  it("keeps $0.045 as the cap for a path it does not know, and the keyword MCP endpoint", () => {
    expect(DEFAULT_KEYWORDS_MAX_PRICE_USD).toBe(0.045);
    expect(KEYWORDS_MCP_URL).toBe("https://keywords.duoleads.com/mcp");
  });

  it("maps every method to its path, HTTP method and input, on https://keywords.duoleads.com", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createKeywordsClient({ fetch: fetchImpl }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const route of KEYWORDS_ROUTES) {
      const data = await client[route.method]?.(INPUTS[route.method] ?? {});
      expect(data, route.path).toEqual(KW_EXAMPLES[route.path]);
      const last = calls.at(-1);
      expect(last?.url.origin).toBe("https://keywords.duoleads.com");
      expect(last?.url.pathname).toBe(route.path);
      expect(last?.init?.method).toBe(route.httpMethod);
      if (route.httpMethod === "POST") {
        expect(last?.url.search).toBe("");
        expect(JSON.parse(String(last?.init?.body))).toEqual(INPUTS[route.method]);
        expect((last?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
      } else {
        expect(last?.init?.body).toBeUndefined();
      }
    }
    expect(calls).toHaveLength(6);
    // search-volume: the array becomes the comma-separated list the GET route reads
    expect(calls[1]?.url.search).toBe("?keywords=phone%2Cwatch&country=us&lang=en");
    expect(calls[3]?.url.search).toBe("?keyword=seo+tools&country=us&timeframe=past_12_months");
  });

  it("drops null and undefined members from a POST body", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createKeywordsClient({ fetch: fetchImpl }).keywordIdeas({ keyword: "phone", limit: undefined, country: null as unknown as string });
    expect(calls[0]?.init?.body).toBe('{"keyword":"phone"}');
  });
});

describe("paying keyword routes with a wallet (mocked 402)", () => {
  it("pays the $0.04 challenge of search-volume once, to the service address", async () => {
    const { account, signer, signTypedData } = spySigner();
    const server = await kwServer();
    try {
      const result = await createKeywordsClient({ account: signer, baseUrl: server.baseUrl }).callWithReceipt("/v1/search-volume", { keywords: ["phone", "watch"] });
      expect(result.data).toEqual(KW_EXAMPLES["/v1/search-volume"]);
      expect(result.receipt).toMatchObject({ success: true, network: "eip155:8453" });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(server.requests.map((r) => [r.method, r.search])).toEqual([
        ["GET", "?keywords=phone%2Cwatch"],
        ["GET", "?keywords=phone%2Cwatch"],
      ]);
      const signed = decodePaymentSignature(server.requests[1]?.paymentSignature ?? "");
      expect(signed.payload.authorization).toMatchObject({ from: account.address, to: PAY_TO, value: "40000" });
      expect(signed.accepted).toMatchObject({ amount: "40000", asset: BASE_USDC, network: "eip155:8453", payTo: PAY_TO });
    } finally {
      await server.close();
    }
  });

  it("pays a POST route and repeats the same JSON body on the paid retry", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await kwServer();
    try {
      const overview = await createKeywordsClient({ account: signer, baseUrl: server.baseUrl }).keywordOverview({ keywords: ["phone", "watch"] });
      expect(overview.results.map((r) => r.keyword)).toEqual(["phone", "watch"]);
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(server.requests.map((r) => [r.method, r.body, r.contentType])).toEqual([
        ["POST", '{"keywords":["phone","watch"]}', "application/json"],
        ["POST", '{"keywords":["phone","watch"]}', "application/json"],
      ]);
      expect(decodePaymentSignature(server.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("40000");
    } finally {
      await server.close();
    }
  });

  it("pays $0.045 for trend by default; with maxPriceUsd 0.04 refuses trend and signs nothing for it", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await kwServer();
    try {
      await createKeywordsClient({ account: signer, baseUrl: server.baseUrl }).trend({ keyword: "seo tools" });
      expect(decodePaymentSignature(server.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("45000");
      expect(signTypedData).toHaveBeenCalledTimes(1);
      const capped = createKeywordsClient({ account: signer, baseUrl: server.baseUrl, maxPriceUsd: 0.04 });
      await expect(capped.trend({ keyword: "seo tools" })).rejects.toThrow(/45000 atomic units \(\$0\.045\) is above the maximum \$0\.04/);
      await capped.relatedQueries({ keyword: "seo api" });
      expect(signTypedData).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("refuses $0.05 (a main-API price) by default and signs nothing", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await kwServer(() => "50000");
    try {
      const error = await createKeywordsClient({ account: signer, baseUrl: server.baseUrl }).searchVolume({ keywords: "phone" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PriceGuardError);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(server.requests.every((r) => r.paymentSignature === null)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("refuses another payee without signing", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await startMockServer((request): MockReply => ({
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": kwChallengeHeader(request.path, "30000", (c) => ((c.accepts[0] as Requirement).payTo = "0x0000000000000000000000000000000000000002")),
      },
    }));
    try {
      await expect(createKeywordsClient({ account: signer, baseUrl: server.baseUrl }).interestByRegion({ keyword: "seo api" })).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("client.keywords from createClient shares the wallet, has its own cap and sends the SDK User-Agent", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await kwServer((path) => (path === "/v1/related-queries" ? "46000" : (PLAN_PRICES[path] ?? "0")));
    try {
      const client = createClient({ account: signer, keywords: { baseUrl: server.baseUrl } });
      // 46000 is refused although the main API's cap is 50000: client.keywords caps related-queries at its own $0.03.
      await expect(client.keywords.relatedQueries({ keyword: "seo api" })).rejects.toThrow(/above the maximum \$0\.03\b/);
      expect(signTypedData).not.toHaveBeenCalled();
      await client.keywords.keywordIdeas({ keyword: "phone", limit: 2 });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(server.requests.slice(-2).map((r) => r.userAgent)).toEqual([SDK_USER_AGENT, SDK_USER_AGENT]);
    } finally {
      await server.close();
    }
  });
});

describe("keyword errors and inputs", () => {
  it("throws DuoApiError with code, param, expected and request id from the error body", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        { error: { status: 400, code: "INVALID_PARAM", message: "country is not supported.", param: "country", expected: "an ISO 3166-1 alpha-2 code" }, request_id: "01KTEST" },
        { status: 400 },
      ),
    );
    const error = await createKeywordsClient({ fetch: fetchImpl }).searchVolume({ keywords: "phone", country: "zz" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuoApiError);
    expect(error).toMatchObject({ code: "INVALID_PARAM", param: "country", expected: "an ISO 3166-1 alpha-2 code", status: 400, route: "/v1/search-volume", requestId: "01KTEST" });
  });

  it("reports a 503 'nothing was charged' answer, PAYMENT_REQUIRED, INVALID_RESPONSE and HTTP_<status>", async () => {
    const unavailable = fakeFetch(() => jsonResponse({ error: { status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Upstream failed; nothing was charged." } }, { status: 503 }));
    await expect(createKeywordsClient({ fetch: unavailable.fetchImpl }).trend({ keyword: "x" })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 503 });
    await expect(createKeywordsClient({ fetch: fakeFetch(() => new Response("", { status: 402 })).fetchImpl }).trend({ keyword: "x" })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    await expect(createKeywordsClient({ fetch: fakeFetch(() => new Response("<html>", { status: 200 })).fetchImpl }).trend({ keyword: "x" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(createKeywordsClient({ fetch: fakeFetch(() => new Response("down", { status: 502 })).fetchImpl }).trend({ keyword: "x" })).rejects.toMatchObject({ code: "HTTP_502" });
  });

  it("refuses a keyword containing a comma before any request (it would become two keywords)", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await expect(createKeywordsClient({ fetch: fetchImpl }).searchVolume({ keywords: ["phone", "a,b"] })).rejects.toThrow(/keywords\[1\]/);
    expect(calls).toHaveLength(0);
    expect(buildKeywordsQuery({ keywords: "phone,watch", includeMonthly: true, skip: undefined })).toBe("keywords=phone%2Cwatch&includeMonthly=true");
    expect(() => buildKeywordsQuery({ limit: Number.NaN })).toThrow(TypeError);
  });

  it("refuses anything that is not a keyword route path, before any request", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createKeywordsClient({ fetch: fetchImpl });
    for (const path of ["/mcp", "/v1/id/iban", "/v1/../mcp", "https://evil.example/v1/trend", "/v1/Trend"]) {
      await expect(client.call(path), path).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("needs exactly one of account or fetch, and https outside localhost", () => {
    expect(() => createKeywordsClient()).toThrow(TypeError);
    expect(() => createKeywordsClient({ fetch: fakeFetch().fetchImpl, baseUrl: "http://keywords.example.com" })).toThrow(/must use https/);
    expect(() => createKeywordsClient({ fetch: fakeFetch().fetchImpl, maxPriceUsd: 0 })).toThrow(RangeError);
  });
});
