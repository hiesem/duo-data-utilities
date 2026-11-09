// Client for https://keywords.duoleads.com: SEO and keyword data. 44 routes: Google search volume, CPC, competition,
// keyword difficulty and intent (Google Ads data), keyword ideas, Google Trends, domain and ranking data, backlinks,
// on-page and PageSpeed audits, Amazon keywords, Google / Bing / YouTube / Maps results, brand and AI-answer
// visibility, tech stack and WHOIS. $0.012 to $0.25 per call, paid with x402 v2 (USDC on Base).
//
// Differences from the main API that this file handles:
//   - paths are /v1/<name> (one segment), e.g. /v1/search-volume;
//   - each route has one HTTP method (SEO_KEYWORD_ROUTES): most are POST with a JSON body, the others GET;
//   - a 200 answer is the data object itself (no {ok, data, meta} envelope);
//   - an error answer is {error: {status, code, message, param?, expected?}, request_id?}.
import { DuoApiError } from "./errors.js";
import { DEFAULT_PAY_TO, usdToAtomic } from "./price-guard.js";
import { createSeoKeywordGeneratedClient, SEO_KEYWORD_ROUTES, type SeoKeywordGeneratedClient } from "./seo-generated.js";
import {
  buildPayingFetch,
  canSetUserAgent,
  isRecord,
  normaliseBaseUrl,
  parseJson,
  receiptOf,
  type EvmSigner,
  type FetchLike,
  type SettlementReceipt,
} from "./transport.js";
import { SDK_USER_AGENT } from "./version.js";

export const DEFAULT_KEYWORDS_BASE_URL = "https://keywords.duoleads.com";
/**
 * Largest price `client.keywords` signs by default for one call to a path it does not know, in USD. Every listed
 * route (SEO_KEYWORD_ROUTES, the six original routes included) is capped by default at its own listed price, so a
 * challenge above that price is refused.
 */
export const DEFAULT_KEYWORDS_MAX_PRICE_USD = 0.045;
/** The most expensive keyword route (historical-rank), in USD. */
export const KEYWORDS_MAX_ROUTE_PRICE_USD = 0.25;
/** The paid MCP endpoint of the keyword service (Streamable HTTP; payment in `_meta["x402/payment"]`). */
export const KEYWORDS_MCP_URL = "https://keywords.duoleads.com/mcp";

/** One keyword route: client method, HTTP method, path, MCP tool name and price (atomic USDC and USD). */
export interface KeywordsRoute {
  method: "keywordOverview" | "searchVolume" | "keywordIdeas" | "trend" | "relatedQueries" | "interestByRegion";
  httpMethod: "GET" | "POST";
  path: string;
  tool: string;
  amount: string;
  priceUsd: string;
}

/** The six original routes of https://keywords.duoleads.com, with hand-written methods. All 44 routes: SEO_KEYWORD_ROUTES. */
export const KEYWORDS_ROUTES: readonly KeywordsRoute[] = [
  { method: "keywordOverview", httpMethod: "POST", path: "/v1/keyword-overview", tool: "keyword_overview", amount: "40000", priceUsd: "0.04" },
  { method: "searchVolume", httpMethod: "GET", path: "/v1/search-volume", tool: "keyword_search_volume", amount: "40000", priceUsd: "0.04" },
  { method: "keywordIdeas", httpMethod: "POST", path: "/v1/keyword-ideas", tool: "keyword_ideas", amount: "40000", priceUsd: "0.04" },
  { method: "trend", httpMethod: "GET", path: "/v1/trend", tool: "google_trends", amount: "45000", priceUsd: "0.045" },
  { method: "relatedQueries", httpMethod: "GET", path: "/v1/related-queries", tool: "google_trends_related_queries", amount: "30000", priceUsd: "0.03" },
  { method: "interestByRegion", httpMethod: "GET", path: "/v1/interest-by-region", tool: "google_trends_by_region", amount: "30000", priceUsd: "0.03" },
];

export type TrendsTimeframe = "past_7_days" | "past_30_days" | "past_90_days" | "past_12_months" | "past_5_years";

/** POST /v1/keyword-overview: 1 to 100 keywords in one $0.04 call. */
export interface KeywordOverviewParams {
  keywords: string[];
  /** Google Ads location code (geo target ID). Default 2840 (United States). */
  locationCode?: number;
  /** Two-letter language code. Default en. */
  languageCode?: string;
  /** ISO 3166-1 alpha-2 code or country name, used when locationCode is absent (uk = gb). */
  country?: string;
  includeMonthly?: boolean;
}

/** GET /v1/search-volume: 1 to 20 keywords in one $0.04 call. */
export interface SearchVolumeParams {
  /** An array (one keyword per element, no commas) or a comma-separated string. */
  keywords: string[] | string;
  /** ISO 3166-1 alpha-2 country code (us, gb, de, ...; uk = gb). Default us. */
  country?: string;
  /** Language offered for the country (en, es, de, ...). */
  lang?: string;
  includeMonthly?: boolean;
}

/** POST /v1/keyword-ideas: up to 100 ideas for one seed in one $0.04 call. */
export interface KeywordIdeasParams {
  keyword: string;
  /** Maximum ideas to return (1 to 100). Default 20. */
  limit?: number;
  locationCode?: number;
  languageCode?: string;
  country?: string;
  includeMonthly?: boolean;
}

/** GET /v1/trend ($0.045), /v1/related-queries and /v1/interest-by-region ($0.03): one keyword. */
export interface TrendsParams {
  keyword: string;
  /** ISO 3166-1 alpha-2 country code; omit for worldwide. */
  country?: string;
  /** Time window. Default past_12_months. */
  timeframe?: TrendsTimeframe;
}

/** Metrics of one keyword. volume = average monthly searches, cpc in USD, competition 0-1, difficulty 0-100. */
export interface KeywordMetrics {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel: string | null;
  difficulty: number | null;
  intent: string | null;
  trendYoyPct: number | null;
  monthly?: Array<{ year: number; month: number; volume: number | null }>;
  [key: string]: unknown;
}

export interface KeywordMarket {
  locationCode: number;
  locationName: string;
  country: string;
  languageCode?: string;
  fallback?: boolean;
  [key: string]: unknown;
}

/** Answer of keyword-overview and search-volume. Keywords without data are listed in `missing` (still charged). */
export interface KeywordOverviewData {
  total: number;
  results: KeywordMetrics[];
  missing: string[];
  market: KeywordMarket;
  request_id?: string;
  [key: string]: unknown;
}

export interface KeywordIdeasData {
  seed: string;
  total: number;
  results: KeywordMetrics[];
  available: number;
  market: KeywordMarket;
  request_id?: string;
  [key: string]: unknown;
}

export interface TrendData {
  keyword: string;
  country: string | null;
  timeframe: TrendsTimeframe;
  granularity: string;
  series: Array<{ date: string; value: number; partial?: boolean }>;
  request_id?: string;
  [key: string]: unknown;
}

export interface RelatedQueriesData {
  keyword: string;
  /** Top related searches, value 0-100. */
  top: Array<{ term: string; value: number; [key: string]: unknown }>;
  /** Rising related searches, value = % growth. */
  rising: Array<{ term: string; value: number | string; [key: string]: unknown }>;
  request_id?: string;
  [key: string]: unknown;
}

export interface InterestByRegionData {
  keyword: string;
  resolution: string;
  regions: Array<{ region: string; code: string; value: number; [key: string]: unknown }>;
  request_id?: string;
  [key: string]: unknown;
}

export interface KeywordsClientOptions {
  /** Wallet that pays each call. Use this, or `fetch`, not both. */
  account?: EvmSigner;
  /** A fetch that already pays 402 challenges. The price guard cannot inspect payments made inside it. */
  fetch?: FetchLike;
  /** API origin. Default https://keywords.duoleads.com. Plain http is only accepted for localhost. */
  baseUrl?: string;
  /**
   * Largest price in USD signed for one call, on every route. Default: each route's own listed price ($0.012 to
   * $0.25), and 0.045 for a path the client does not know. Set 0.04 to refuse trend and every route above $0.04.
   */
  maxPriceUsd?: number;
  /** The only payee signed for. Default 0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39; null accepts any. */
  payTo?: string | null;
  /** The User-Agent sent with every request. Default `SDK_USER_AGENT`. */
  userAgent?: string;
}

/** A keyword answer with the settlement receipt. */
export interface KeywordsPaidResult<T> {
  data: T;
  /** Null when the response had no PAYMENT-RESPONSE header, or the header could not be decoded. */
  receipt: SettlementReceipt | null;
}

export interface KeywordsClient extends SeoKeywordGeneratedClient {
  /** POST /v1/keyword-overview ($0.04): volume, CPC, competition, difficulty and intent for 1-100 keywords. */
  keywordOverview(params: KeywordOverviewParams): Promise<KeywordOverviewData>;
  /** GET /v1/search-volume ($0.04): the same metrics for 1-20 keywords in a country. */
  searchVolume(params: SearchVolumeParams): Promise<KeywordOverviewData>;
  /** POST /v1/keyword-ideas ($0.04): related keyword ideas with metrics for one seed. */
  keywordIdeas(params: KeywordIdeasParams): Promise<KeywordIdeasData>;
  /** GET /v1/trend ($0.045): Google Trends interest over time (0-100). */
  trend(params: TrendsParams): Promise<TrendData>;
  /** GET /v1/related-queries ($0.03): Google Trends top and rising related queries. */
  relatedQueries(params: TrendsParams): Promise<RelatedQueriesData>;
  /** GET /v1/interest-by-region ($0.03): Google Trends interest per region. */
  interestByRegion(params: TrendsParams): Promise<InterestByRegionData>;
  /** Calls any keyword route by path, with the route's own HTTP method (POST with a JSON body, or GET). */
  call<T = unknown>(path: string, params?: object): Promise<T>;
  /** Like `call`, and also returns the settlement receipt. */
  callWithReceipt<T = unknown>(path: string, params?: object): Promise<KeywordsPaidResult<T>>;
}

const KEYWORDS_PATH = /^\/v1\/[a-z0-9-]+$/;

export function assertKeywordsPath(path: string): void {
  if (!KEYWORDS_PATH.test(path)) throw new TypeError(`not a keyword route path: ${JSON.stringify(path)} (expected /v1/<name>)`);
}

/**
 * Query string for a GET keyword route. A `keywords` array becomes the comma-separated list the API reads; an
 * element containing a comma is refused (it would silently become two keywords). null and undefined are omitted.
 */
export function buildKeywordsQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const bad = value.findIndex((s) => typeof s !== "string" || s.includes(","));
      if (bad >= 0) throw new TypeError(`${key}[${bad}] must be a string without commas (one keyword per element)`);
      search.append(key, value.join(","));
    } else if (typeof value === "string" || typeof value === "boolean") search.append(key, String(value));
    else if (typeof value === "number" && Number.isFinite(value)) search.append(key, String(value));
    else throw new TypeError(`parameter ${key} must be a string, finite number, boolean or string array`);
  }
  return search.toString();
}

function keywordsError(path: string, status: number, ok: boolean, body: unknown): DuoApiError {
  const requestId = isRecord(body) && typeof body.request_id === "string" ? body.request_id : null;
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    return new DuoApiError({
      code: typeof error.code === "string" ? error.code : "UNKNOWN_ERROR",
      message: typeof error.message === "string" ? error.message : `${path} failed with HTTP ${status}`,
      param: typeof error.param === "string" ? error.param : null,
      expected: typeof error.expected === "string" ? error.expected : null,
      status,
      route: path,
      requestId,
    });
  }
  if (status === 402) {
    return new DuoApiError({ code: "PAYMENT_REQUIRED", message: "the payment was not accepted (HTTP 402)", status, route: path, requestId });
  }
  if (ok) {
    return new DuoApiError({ code: "INVALID_RESPONSE", message: `${path} did not return a JSON object (HTTP ${status})`, status, route: path, requestId });
  }
  return new DuoApiError({ code: `HTTP_${status}`, message: `${path} failed with HTTP ${status}`, status, route: path, requestId });
}

const POST_PATHS = new Set<string>(SEO_KEYWORD_ROUTES.filter((r) => r.httpMethod === "POST").map((r) => r.path));
/** Default cap per path when the caller set no maxPriceUsd: each of the 44 routes' own price (unknown paths: the default). */
const ROUTE_CAP_USD = new Map<string, number>(SEO_KEYWORD_ROUTES.map((r) => [r.path, Number(r.priceUsd)]));

/** Drops null and undefined members: the JSON body of a POST route. */
function bodyOf(params: object): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body[k] = v;
  return JSON.stringify(body);
}

/**
 * Creates a client for https://keywords.duoleads.com. Pass `account` to pay with your own wallet (USDC on Base
 * via x402). Before it signs, the client refuses any price above `maxPriceUsd` (default: each route's own listed
 * price).
 * `createClient(...).keywords` is the same client, sharing the wallet with the main API.
 */
export function createKeywordsClient(options: KeywordsClientOptions = {}): KeywordsClient {
  if ((options.account !== undefined) === (options.fetch !== undefined)) {
    throw new TypeError("createKeywordsClient needs exactly one of `account` (pays with your wallet) or `fetch` (a fetch that already pays)");
  }
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_KEYWORDS_BASE_URL);
  const userAgent = options.userAgent ?? SDK_USER_AGENT;
  if (/[\r\n]/.test(userAgent)) throw new TypeError("userAgent must not contain line breaks");
  const capFor = (path: string): number => options.maxPriceUsd ?? ROUTE_CAP_USD.get(path) ?? DEFAULT_KEYWORDS_MAX_PRICE_USD;
  usdToAtomic(capFor("")); // validates maxPriceUsd at construction, as before
  const payTo = options.payTo === undefined ? DEFAULT_PAY_TO : options.payTo;
  const account = options.account;
  // One paying fetch per price cap (at most one per distinct route price), built on first use.
  const byCap = new Map<number, FetchLike>();
  const payingFetchFor = (path: string): FetchLike => {
    if (account === undefined) return options.fetch as FetchLike;
    const cap = capFor(path);
    let f = byCap.get(cap);
    if (!f) byCap.set(cap, (f = buildPayingFetch(account, usdToAtomic(cap), cap, payTo)));
    return f;
  };

  const callPaid = async <T>(path: string, params: object = {}): Promise<KeywordsPaidResult<T>> => {
    assertKeywordsPath(path);
    const headers: Record<string, string> = { accept: "application/json" };
    if (canSetUserAgent() && userAgent) headers["user-agent"] = userAgent;
    let response: Response;
    const payingFetch = payingFetchFor(path);
    if (POST_PATHS.has(path)) {
      headers["content-type"] = "application/json";
      response = await payingFetch(`${baseUrl}${path}`, { method: "POST", headers, body: bodyOf(params) });
    } else {
      const query = buildKeywordsQuery(params);
      response = await payingFetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, { method: "GET", headers });
    }
    const body = parseJson(await response.text());
    if (response.ok && isRecord(body) && !("error" in body)) return { data: body as T, receipt: receiptOf(response) };
    throw keywordsError(path, response.status, response.ok, body);
  };
  const call = async <T>(path: string, params: object): Promise<T> => (await callPaid<T>(path, params)).data;

  return {
    ...createSeoKeywordGeneratedClient(call),
    keywordOverview: (p) => call<KeywordOverviewData>("/v1/keyword-overview", p),
    searchVolume: (p) => call<KeywordOverviewData>("/v1/search-volume", p),
    keywordIdeas: (p) => call<KeywordIdeasData>("/v1/keyword-ideas", p),
    trend: (p) => call<TrendData>("/v1/trend", p),
    relatedQueries: (p) => call<RelatedQueriesData>("/v1/related-queries", p),
    interestByRegion: (p) => call<InterestByRegionData>("/v1/interest-by-region", p),
    call: <T = unknown>(path: string, params?: object) => call<T>(path, params ?? {}),
    callWithReceipt: <T = unknown>(path: string, params?: object) => callPaid<T>(path, params ?? {}),
  };
}
