// 0.3.0: the 38 newer keyword routes, the social client, and back-compatibility with 0.2.0.
// Nothing touches the network and nothing is paid: challenges are mocked on a loopback server and the signer is a
// throwaway account generated at run time.
// Independent authority for prices and methods: spec/fixtures/live-402-amounts.json, the amounts of each route's
// real unpaid 402 challenge (captured 2026-11-08 without paying), not the OpenAPI the clients are generated from.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as sdk from "../src/index.js";
import {
  createClient,
  createKeywordsClient,
  createSocialClient,
  DEFAULT_KEYWORDS_MAX_PRICE_USD,
  DEFAULT_SOCIAL_MAX_PRICE_USD,
  DuoApiError,
  KEYWORDS_ROUTES,
  PriceGuardError,
  SEO_KEYWORD_ROUTES,
  SOCIAL_MCP_URL,
  SOCIAL_ROUTES,
  type EvmSigner,
} from "../src/index.js";
import { challengeHeader, jsonResponse, PAY_TO, paymentResponseHeader, type Challenge, type Requirement } from "./helpers/challenge.js";
import { startMockServer, type MockReply } from "./helpers/mock-server.js";

const live = JSON.parse(readFileSync(new URL("../spec/fixtures/live-402-amounts.json", import.meta.url), "utf8")) as {
  routes: Record<string, { method: string; status: number; amount: string; payTo: string }>;
};
const liveFor = (host: string, path: string) => live.routes[`https://${host}${path}`];

function spySigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signTypedData = vi.fn((message: unknown) => account.signTypedData(message as Parameters<typeof account.signTypedData>[0]));
  return { signer: { address: account.address, signTypedData } as unknown as EvmSigner, signTypedData };
}
const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { payload: { authorization: { value: string; to: string } } };

function challenge(host: string, path: string, amount: string, edit?: (c: Challenge) => void): string {
  return challengeHeader((c) => {
    (c.accepts[0] as Requirement).amount = amount;
    c.resource = { url: `https://${host}${path}`, mimeType: "application/json" };
    delete c.extensions;
    edit?.(c);
  });
}

async function server(host: string, amountFor: (path: string) => string, answer: unknown = { ok: "data" }) {
  return startMockServer((r): MockReply => {
    if (!r.paymentSignature) return { status: 402, headers: { "PAYMENT-REQUIRED": challenge(host, r.path, amountFor(r.path)) } };
    return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(PAY_TO) }, body: answer };
  });
}

function fakeFetch() {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(String(input)), init });
    return jsonResponse({ ok: "data" });
  };
  return { calls, fetchImpl };
}

describe("back-compatibility with 0.2.0", () => {
  it("still exports every runtime name 0.2.0 exported", () => {
    const old = JSON.parse(readFileSync(new URL("./fixtures/exports-0.2.0.json", import.meta.url), "utf8")) as string[];
    for (const name of old) expect(Object.keys(sdk), name).toContain(name);
  });
  it("keeps the six original keyword routes and the $0.045 default", () => {
    expect(KEYWORDS_ROUTES.map((r) => r.path)).toEqual(["/v1/keyword-overview", "/v1/search-volume", "/v1/keyword-ideas", "/v1/trend", "/v1/related-queries", "/v1/interest-by-region"]);
    expect(DEFAULT_KEYWORDS_MAX_PRICE_USD).toBe(0.045);
  });
});

describe("keyword route table (44 routes)", () => {
  it("matches every live 402 challenge: amount, HTTP method and payee", () => {
    expect(SEO_KEYWORD_ROUTES).toHaveLength(44);
    for (const r of SEO_KEYWORD_ROUTES) {
      const l = liveFor("keywords.duoleads.com", r.path);
      expect(l?.status, r.path).toBe(402);
      expect(r.amount, r.path).toBe(l?.amount);
      expect(r.httpMethod, r.path).toBe(l?.method);
      expect(l?.payTo).toBe(PAY_TO);
      expect(Number(r.priceUsd) * 1e6).toBeCloseTo(Number(r.amount));
    }
    for (const v1 of KEYWORDS_ROUTES) expect(SEO_KEYWORD_ROUTES.find((r) => r.path === v1.path)).toMatchObject({ amount: v1.amount, httpMethod: v1.httpMethod });
  });

  it("every one of the 44 routes has a client method that calls its path with its own HTTP method", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createKeywordsClient({ fetch: fetchImpl }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const r of SEO_KEYWORD_ROUTES) {
      expect(typeof client[r.method], r.method).toBe("function");
      await client[r.method]?.({ target: "example.com", keyword: "phone", keywords: ["phone"], q: "coffee" });
      const last = calls.at(-1);
      expect(last?.url.pathname, r.path).toBe(r.path);
      expect(last?.init?.method, r.path).toBe(r.httpMethod);
      if (r.httpMethod === "POST") {
        expect(last?.url.search).toBe("");
        expect((last?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
      } else expect(last?.init?.body).toBeUndefined();
    }
    expect(calls).toHaveLength(44);
  });

  it("caps a newer route at its own price by default: pays historical-rank $0.25, refuses $0.26", async () => {
    const { signer, signTypedData } = spySigner();
    const s = await server("keywords.duoleads.com", () => "250000");
    try {
      const kw = createKeywordsClient({ account: signer, baseUrl: s.baseUrl });
      await kw.historicalRank({ target: "example.com" });
      expect(decode(s.requests[1]?.paymentSignature ?? "").payload.authorization).toMatchObject({ value: "250000", to: PAY_TO });
      expect(s.requests[1]?.body).toBe('{"target":"example.com"}');
      // the same $0.25 challenge on a $0.048 route is refused, nothing signed
      await expect(kw.backlinks({ target: "example.com" })).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it("an explicit maxPriceUsd applies to every route; the six original routes keep the $0.045 default", async () => {
    const { signer, signTypedData } = spySigner();
    const s = await server("keywords.duoleads.com", (p) => (p === "/v1/related-queries" ? "46000" : "48000"));
    try {
      await expect(createKeywordsClient({ account: signer, baseUrl: s.baseUrl, maxPriceUsd: 0.04 }).keywordGap({ domain: "a.com", competitor: "b.com" })).rejects.toThrow(/above the maximum \$0\.04/);
      await expect(createKeywordsClient({ account: signer, baseUrl: s.baseUrl }).relatedQueries({ keyword: "x" })).rejects.toThrow(/above the maximum \$0\.045/);
      expect(signTypedData).not.toHaveBeenCalled();
      await createKeywordsClient({ account: signer, baseUrl: s.baseUrl }).keywordGap({ domain: "a.com", competitor: "b.com" });
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it("a GET newer route sends its parameters as a query string", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createKeywordsClient({ fetch: fetchImpl }).serp({ q: "coffee maker", country: "us", num: 20 });
    expect(calls[0]?.url.search).toBe("?q=coffee+maker&country=us&num=20");
  });
});

describe("social client (26 routes)", () => {
  it("matches every live 402 challenge and is GET only", () => {
    expect(SOCIAL_ROUTES).toHaveLength(26);
    for (const r of SOCIAL_ROUTES) {
      const l = liveFor("social.duoleads.com", r.path);
      expect(l?.status, r.path).toBe(402);
      expect(r.amount, r.path).toBe(l?.amount);
      expect(r.httpMethod).toBe("GET");
    }
    expect(SOCIAL_MCP_URL).toBe("https://social.duoleads.com/mcp");
    expect(DEFAULT_SOCIAL_MAX_PRICE_USD).toBe(0.025);
  });

  it("every route has a method that GETs its path on https://social.duoleads.com", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createSocialClient({ fetch: fetchImpl }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const r of SOCIAL_ROUTES) await client[r.method]?.({ q: "open source", limit: 10 });
    expect(calls.map((c) => [c.url.origin, c.url.pathname, c.init?.method])).toEqual(SOCIAL_ROUTES.map((r) => ["https://social.duoleads.com", r.path, "GET"]));
    expect(calls[0]?.url.search).toBe("?q=open+source&limit=10");
  });

  it("pays a $0.01 route once at its price and refuses a $0.02 challenge on it", async () => {
    const { signer, signTypedData } = spySigner();
    const s = await server("social.duoleads.com", (p) => (p === "/v1/bluesky/search" ? "10000" : "20000"));
    try {
      const social = createSocialClient({ account: signer, baseUrl: s.baseUrl });
      const r = await social.callWithReceipt("/v1/bluesky/search", { q: "open source" });
      expect(r.data).toEqual({ ok: "data" });
      expect(r.receipt).toMatchObject({ success: true });
      expect(decode(s.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("10000");
      await expect(social.call("/v1/bluesky/posts", { handle: "bsky.app" })).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it("client.social from createClient shares the wallet and sends the SDK User-Agent", async () => {
    const { signer, signTypedData } = spySigner();
    const s = await server("social.duoleads.com", () => "20000");
    try {
      await createClient({ account: signer, social: { baseUrl: s.baseUrl } }).social.xSearch({ q: "nasa" });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(s.requests.map((r) => r.userAgent)).toEqual([sdk.SDK_USER_AGENT, sdk.SDK_USER_AGENT]);
    } finally {
      await s.close();
    }
  });

  it("throws DuoApiError from the error body and refuses bad paths and numbers before any request", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { status: 400, code: "INVALID_PARAM", message: "limit must be from 1 to 25. Nothing was charged.", param: "limit", expected: "an integer from 1 to 25" }, request_id: "01X" }), { status: 400 });
    const error = (await createSocialClient({ fetch: fetchImpl }).blueskySearch({ q: "x", limit: 99 }).catch((e: unknown) => e)) as DuoApiError;
    expect(error).toBeInstanceOf(DuoApiError);
    expect(error).toMatchObject({ code: "INVALID_PARAM", param: "limit", status: 400, requestId: "01X", route: "/v1/bluesky/search" });
    const { calls, fetchImpl: f2 } = fakeFetch();
    const social = createSocialClient({ fetch: f2 });
    await expect(social.call("/v1/../x")).rejects.toThrow(TypeError);
    await expect(social.call("/v1/bluesky/search", { limit: Number.NaN })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("the four published packages", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const PACKAGES = ["x402-seo-keyword-data", "x402-crypto-derivatives-data", "x402-social-media-data"];
  // Upstream data providers are never named in package text (fragments, so this file does not contain them).
  const vendors = [new RegExp("data" + "for" + "seo", "i"), new RegExp("scrape" + "creators", "i"), new RegExp("twitter" + "api\\.io", "i"), /\bKVK\b/];

  it("each standalone package is 0.3.x, self-contained, publishes only dist + README + LICENSE, links its own mirror repo", () => {
    const root = JSON.parse(read("package.json")) as { version: string; dependencies: Record<string, string> };
    for (const name of PACKAGES) {
      const pkg = JSON.parse(read(`packages/${name}/package.json`)) as Record<string, any>;
      expect(pkg.name).toBe(name);
      expect(pkg.version).toMatch(/^0\.3\.\d+$/);
      expect(pkg.license).toBe("MIT");
      expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
      expect(pkg.dependencies).toEqual(root.dependencies);
      expect(Object.keys(pkg.dependencies)).not.toContain("duo-data-utilities");
      expect(pkg.repository).toEqual({ type: "git", url: `git+https://github.com/hiesem/${name}.git` });
      expect(pkg.homepage).toBe(`https://github.com/hiesem/${name}#readme`);
      expect(read(`packages/${name}/README.md`)).toContain(`https://github.com/hiesem/${name}`);
      expect(read(`packages/${name}/LICENSE`)).toBe(read("LICENSE"));
    }
  });

  it("no package text names an upstream data provider", () => {
    const texts = ["README.md", "package.json", ...PACKAGES.flatMap((n) => [`packages/${n}/README.md`, `packages/${n}/package.json`]), "src/seo-generated.ts", "src/social-generated.ts", "src/keywords.ts", "src/social.ts"];
    for (const rel of texts) for (const v of vendors) expect(read(rel), `${rel} ${v}`).not.toMatch(v);
  });

  it("each package README links the service's docs, OpenAPI, llms.txt, terms and privacy", () => {
    const host: Record<string, string> = { "x402-seo-keyword-data": "keywords", "x402-crypto-derivatives-data": "derivs", "x402-social-media-data": "social" };
    for (const name of PACKAGES) {
      const readme = read(`packages/${name}/README.md`);
      for (const page of ["docs", "openapi.json", "llms.txt", "terms", "privacy"]) expect(readme, `${name} ${page}`).toContain(`https://${host[name]}.duoleads.com/${page}`);
    }
  });
});

describe("GitHub mirrors (scripts/sync-mirrors.mjs)", () => {
  it("each per-service mirror is generated with every import resolving inside its own tree", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [new URL("../scripts/sync-mirrors.mjs", import.meta.url).pathname, "--check"], { encoding: "utf8" });
    expect(out).toContain("sync-mirrors --check: OK");
    for (const name of ["x402-seo-keyword-data", "x402-crypto-derivatives-data", "x402-social-media-data"]) expect(out).toMatch(new RegExp(`${name}: \\d+ files`));
  });
});
