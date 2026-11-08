// Client for https://social.duoleads.com: social media data for social listening and research. 26 routes: public
// posts, profiles, comments and search on X (Twitter), Reddit, TikTok, Instagram, YouTube, Threads, Facebook ads,
// LinkedIn, Bluesky and Hacker News, cross-platform search and mentions. $0.01 to $0.025 per call, paid with x402 v2
// (USDC on Base).
//
// Differences from the main API that this file handles:
//   - paths are /v1/<platform>/<name>, e.g. /v1/bluesky/search; every route is GET with a query string;
//   - a 200 answer is the data object itself (no {ok, data, meta} envelope);
//   - an error answer is {error: {status, code, message, param?, expected?}, request_id?}.
import { DuoApiError } from "./errors.js";
import { DEFAULT_PAY_TO, usdToAtomic } from "./price-guard.js";
import { createSocialGeneratedClient, SOCIAL_ROUTES, type SocialGeneratedClient } from "./social-generated.js";
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

export const DEFAULT_SOCIAL_BASE_URL = "https://social.duoleads.com";
/**
 * Largest price `client.social` signs by default for a path it does not know, in USD (the most expensive route,
 * social search, costs $0.025). Every listed route is capped by default at its own price.
 */
export const DEFAULT_SOCIAL_MAX_PRICE_USD = 0.025;
/** The paid MCP endpoint of the social service (Streamable HTTP; payment in `_meta["x402/payment"]`). */
export const SOCIAL_MCP_URL = "https://social.duoleads.com/mcp";

export interface SocialClientOptions {
  /** Wallet that pays each call. Use this, or `fetch`, not both. */
  account?: EvmSigner;
  /** A fetch that already pays 402 challenges. The price guard cannot inspect payments made inside it. */
  fetch?: FetchLike;
  /** API origin. Default https://social.duoleads.com. Plain http is only accepted for localhost. */
  baseUrl?: string;
  /**
   * Largest price in USD signed for one call, on every route. Default: each route's own listed price ($0.01, $0.02
   * or $0.025), and 0.025 for a path the client does not know. Set 0.01 to allow the $0.01 routes only.
   */
  maxPriceUsd?: number;
  /** The only payee signed for. Default 0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39; null accepts any. */
  payTo?: string | null;
  /** The User-Agent sent with every request. Default `SDK_USER_AGENT`. */
  userAgent?: string;
}

/** A social answer with the settlement receipt. */
export interface SocialPaidResult<T> {
  /** The JSON body of the answer. */
  data: T;
  /** Null when the response had no PAYMENT-RESPONSE header, or the header could not be decoded. */
  receipt: SettlementReceipt | null;
}

export type SocialClient = SocialGeneratedClient & {
  /** Calls any social route by path (e.g. `/v1/bluesky/search`) and resolves to its JSON body. */
  call<T = unknown>(path: string, params?: object): Promise<T>;
  /** Like `call`, and also returns the settlement receipt. */
  callWithReceipt<T = unknown>(path: string, params?: object): Promise<SocialPaidResult<T>>;
};

// Every social route is GET /v1/<platform>/<name>. Anything else is refused before a request is made.
const SOCIAL_PATH = /^\/v1\/[a-z0-9]+\/[a-z0-9-]+$/;

export function assertSocialPath(path: string): void {
  if (!SOCIAL_PATH.test(path)) throw new TypeError(`not a social route path: ${JSON.stringify(path)} (expected /v1/<platform>/<name>)`);
}

/** Query string for the given parameters. Numbers must be finite; null and undefined are omitted. */
export function buildSocialQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`parameter ${key} must be a finite number`);
      search.append(key, String(value));
    } else if (typeof value === "string" || typeof value === "boolean") search.append(key, String(value));
    else throw new TypeError(`parameter ${key} must be a string, number or boolean`);
  }
  return search.toString();
}

function socialError(path: string, status: number, ok: boolean, body: unknown): DuoApiError {
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

const ROUTE_CAP_USD = new Map<string, number>(SOCIAL_ROUTES.map((r) => [r.path, Number(r.priceUsd)]));

/**
 * Creates a client for https://social.duoleads.com. Pass `account` to pay with your own wallet (USDC on Base via
 * x402). Before it signs, the client refuses any price above `maxPriceUsd` (default: each route's own price).
 * `createClient(...).social` is the same client, sharing the wallet with the main API.
 */
export function createSocialClient(options: SocialClientOptions = {}): SocialClient {
  if ((options.account !== undefined) === (options.fetch !== undefined)) {
    throw new TypeError("createSocialClient needs exactly one of `account` (pays with your wallet) or `fetch` (a fetch that already pays)");
  }
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_SOCIAL_BASE_URL);
  const userAgent = options.userAgent ?? SDK_USER_AGENT;
  if (/[\r\n]/.test(userAgent)) throw new TypeError("userAgent must not contain line breaks");
  const capFor = (path: string): number => options.maxPriceUsd ?? ROUTE_CAP_USD.get(path) ?? DEFAULT_SOCIAL_MAX_PRICE_USD;
  usdToAtomic(capFor("")); // validates maxPriceUsd at construction
  const payTo = options.payTo === undefined ? DEFAULT_PAY_TO : options.payTo;
  const account = options.account;
  const byCap = new Map<number, FetchLike>();
  const payingFetchFor = (path: string): FetchLike => {
    if (account === undefined) return options.fetch as FetchLike;
    const cap = capFor(path);
    let f = byCap.get(cap);
    if (!f) byCap.set(cap, (f = buildPayingFetch(account, usdToAtomic(cap), cap, payTo)));
    return f;
  };

  const callPaid = async <T>(path: string, params: object = {}): Promise<SocialPaidResult<T>> => {
    assertSocialPath(path);
    const query = buildSocialQuery(params);
    const headers: Record<string, string> = { accept: "application/json" };
    if (canSetUserAgent() && userAgent) headers["user-agent"] = userAgent;
    const response = await payingFetchFor(path)(`${baseUrl}${path}${query ? `?${query}` : ""}`, { method: "GET", headers });
    const body = parseJson(await response.text());
    if (response.ok && isRecord(body) && !("error" in body)) return { data: body as T, receipt: receiptOf(response) };
    throw socialError(path, response.status, response.ok, body);
  };

  const call = async <T>(path: string, params: object): Promise<T> => (await callPaid<T>(path, params)).data;
  return {
    ...createSocialGeneratedClient(call),
    call: <T = unknown>(path: string, params?: object) => call<T>(path, params ?? {}),
    callWithReceipt: <T = unknown>(path: string, params?: object) => callPaid<T>(path, params ?? {}),
  };
}
