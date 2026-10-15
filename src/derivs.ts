// Client for https://derivs.duoleads.com: crypto derivatives data (perp funding rates, open interest,
// futures basis, implied volatility, liquidations, order book depth) across Bybit, Hyperliquid, dYdX, Gate,
// Kraken, Bitfinex, Deribit and OKX. $0.003 or $0.005 per call, paid with x402 v2 (USDC on Base).
//
// Differences from the main API that this file handles:
//   - paths are /v1/<name> (one segment), e.g. /v1/funding-rates;
//   - a 200 answer is the data object itself (no {ok, data, meta} envelope);
//   - an error answer is {error: {status, code, message, param?, expected?}, request_id?}.
import { createDerivsGeneratedClient, type DerivsGeneratedClient } from "./derivs-generated.js";
import { DuoApiError } from "./errors.js";
import { DEFAULT_PAY_TO, usdToAtomic } from "./price-guard.js";
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

export const DEFAULT_DERIVS_BASE_URL = "https://derivs.duoleads.com";
/** Largest price `client.derivs` signs for one call by default, in USD: the most expensive route costs $0.005. */
export const DEFAULT_DERIVS_MAX_PRICE_USD = 0.005;
/** The paid MCP endpoint of the derivs service (Streamable HTTP; payment in `_meta["x402/payment"]`). */
export const DERIVS_MCP_URL = "https://derivs.duoleads.com/mcp";

export interface DerivsClientOptions {
  /** Wallet that pays each call. Use this, or `fetch`, not both. */
  account?: EvmSigner;
  /** A fetch that already pays 402 challenges. The price guard cannot inspect payments made inside it. */
  fetch?: FetchLike;
  /** API origin. Default https://derivs.duoleads.com. Plain http is only accepted for localhost. */
  baseUrl?: string;
  /** Largest price in USD signed for one call. Default 0.005. Set 0.003 to refuse the $0.005 routes. */
  maxPriceUsd?: number;
  /** The only payee signed for. Default 0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39; null accepts any. */
  payTo?: string | null;
  /** The User-Agent sent with every request. Default `SDK_USER_AGENT`. */
  userAgent?: string;
}

/** A derivs answer with the settlement receipt. */
export interface DerivsPaidResult<T> {
  /** The JSON body of the answer. */
  data: T;
  /** Null when the response had no PAYMENT-RESPONSE header, or the header could not be decoded. */
  receipt: SettlementReceipt | null;
}

export type DerivsClient = DerivsGeneratedClient & {
  /** Calls any derivs route by path (e.g. `/v1/funding-rates`) and resolves to its JSON body. */
  call<T = unknown>(path: string, params?: object): Promise<T>;
  /** Like `call`, and also returns the settlement receipt. */
  callWithReceipt<T = unknown>(path: string, params?: object): Promise<DerivsPaidResult<T>>;
};

// Every derivs route is GET /v1/<name>. Anything else is refused before a request is made.
const DERIVS_PATH = /^\/v1\/[a-z0-9-]+$/;

export function assertDerivsPath(path: string): void {
  if (!DERIVS_PATH.test(path)) throw new TypeError(`not a derivs route path: ${JSON.stringify(path)} (expected /v1/<name>)`);
}

/** A number as the plain decimal the derivs API reads (no exponent; at most 8 decimals). */
export function derivsNumber(name: string, value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`parameter ${name} must be a finite number`);
  if (Number.isInteger(value)) return BigInt(value).toString();
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/** Query string for the given parameters. null and undefined are omitted. */
export function buildDerivsQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") search.append(key, derivsNumber(key, value));
    else if (typeof value === "string" || typeof value === "boolean") search.append(key, String(value));
    else throw new TypeError(`parameter ${key} must be a string, number or boolean`);
  }
  return search.toString();
}

function derivsError(path: string, status: number, ok: boolean, body: unknown): DuoApiError {
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

/**
 * Creates a client for https://derivs.duoleads.com. Pass `account` to pay with your own wallet (USDC on
 * Base via x402). The client refuses any price above `maxPriceUsd` (default $0.005) before it signs.
 * `createClient(...).derivs` is the same client, sharing the wallet with the main API.
 */
export function createDerivsClient(options: DerivsClientOptions = {}): DerivsClient {
  if ((options.account !== undefined) === (options.fetch !== undefined)) {
    throw new TypeError("createDerivsClient needs exactly one of `account` (pays with your wallet) or `fetch` (a fetch that already pays)");
  }
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_DERIVS_BASE_URL);
  const maxPriceUsd = options.maxPriceUsd ?? DEFAULT_DERIVS_MAX_PRICE_USD;
  const userAgent = options.userAgent ?? SDK_USER_AGENT;
  if (/[\r\n]/.test(userAgent)) throw new TypeError("userAgent must not contain line breaks");
  const maxAtomic = usdToAtomic(maxPriceUsd);
  const payTo = options.payTo === undefined ? DEFAULT_PAY_TO : options.payTo;
  const payingFetch: FetchLike =
    options.account !== undefined ? buildPayingFetch(options.account, maxAtomic, maxPriceUsd, payTo) : (options.fetch as FetchLike);

  const callPaid = async <T>(path: string, params: object = {}): Promise<DerivsPaidResult<T>> => {
    assertDerivsPath(path);
    const query = buildDerivsQuery(params);
    const headers: Record<string, string> = { accept: "application/json" };
    if (canSetUserAgent() && userAgent) headers["user-agent"] = userAgent;
    const response = await payingFetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, { method: "GET", headers });
    const body = parseJson(await response.text());
    if (response.ok && isRecord(body) && !("error" in body)) return { data: body as T, receipt: receiptOf(response) };
    throw derivsError(path, response.status, response.ok, body);
  };

  const call = async <T>(path: string, params: object): Promise<T> => (await callPaid<T>(path, params)).data;
  return {
    ...createDerivsGeneratedClient(call),
    call: <T = unknown>(path: string, params?: object) => call<T>(path, params ?? {}),
    callWithReceipt: <T = unknown>(path: string, params?: object) => callPaid<T>(path, params ?? {}),
  };
}
