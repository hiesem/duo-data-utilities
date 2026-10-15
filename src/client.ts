import { assertRoutePath, buildQuery, type CallRoute } from "./caller.js";
import { checkCounterparty, type CounterpartyInput, type CounterpartyResult } from "./counterparty.js";
import { createDerivsClient, type DerivsClient } from "./derivs.js";
import { DuoApiError } from "./errors.js";
import { createGeneratedClient, type GeneratedClient } from "./generated.js";
import { DEFAULT_MAX_PRICE_USD, DEFAULT_PAY_TO, usdToAtomic } from "./price-guard.js";
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

export type { EvmSigner, SettlementReceipt } from "./transport.js";

export const DEFAULT_BASE_URL = "https://api.duoleads.com";

export interface DuoClientOptions {
  /** Wallet that pays each call. Use this, or `fetch`, not both. */
  account?: EvmSigner;
  /**
   * A fetch that already pays 402 challenges. Use this, or `account`, not both.
   * The price guard cannot inspect payments made inside a custom fetch.
   */
  fetch?: FetchLike;
  /** API origin. Default https://api.duoleads.com. Plain http is only accepted for localhost. */
  baseUrl?: string;
  /** Largest price in USD that the client signs for one call. Default 0.05. */
  maxPriceUsd?: number;
  /**
   * The only payee the client signs for. Default: the service's public address
   * 0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39. Set it when you point `baseUrl` at another deployment,
   * or pass null to accept any payee.
   */
  payTo?: string | null;
  /**
   * The User-Agent sent with every request. Default: `SDK_USER_AGENT`, e.g.
   * "duo-data-utilities-js/0.2.0 (+https://github.com/hiesem/duo-data-utilities)". To append your own
   * product, pass `${SDK_USER_AGENT} my-agent/1.0`. Browsers do not let a page set User-Agent, so the
   * client sends none there.
   */
  userAgent?: string;
  /**
   * Settings for `client.derivs` (crypto derivatives data at https://derivs.duoleads.com). The wallet or
   * fetch, `payTo` and `userAgent` are shared with the main client.
   */
  derivs?: {
    /** Derivs API origin. Default https://derivs.duoleads.com. */
    baseUrl?: string;
    /** Largest price in USD that `client.derivs` signs for one call. Default 0.005. */
    maxPriceUsd?: number;
  };
}

/** A route's result with the response meta and the settlement receipt. */
export interface PaidResult<T> {
  data: T;
  meta: Record<string, unknown>;
  /** Null when the response had no PAYMENT-RESPONSE header, or the header could not be decoded. */
  receipt: SettlementReceipt | null;
}

export type DuoClient = GeneratedClient & {
  /** Calls any route by path and resolves to its `data` object. Costs $0.05 per call. */
  call<T = unknown>(path: string, params?: object): Promise<T>;
  /** Like `call`, and also returns the response meta and the settlement receipt. */
  callWithReceipt<T = unknown>(path: string, params?: object): Promise<PaidResult<T>>;
  /** Runs IBAN, tax ID and country checks: three calls, $0.15. Structure and checksum only. */
  checkCounterparty(input: CounterpartyInput): Promise<CounterpartyResult>;
  /**
   * Crypto derivatives data from https://derivs.duoleads.com: perp funding rates, funding history and
   * arbitrage, perp screener, open interest, futures basis, implied volatility, liquidations, order book
   * depth and a one-call snapshot. $0.003 or $0.005 per call, capped by its own price guard (default $0.005).
   */
  derivs: DerivsClient;
};

function apiError(path: string, status: number, ok: boolean, body: unknown): DuoApiError {
  const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {};
  const requestId = typeof meta.request_id === "string" ? meta.request_id : null;
  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
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
    return new DuoApiError({
      code: "PAYMENT_REQUIRED",
      message: "the payment was not accepted (HTTP 402)",
      status,
      route: path,
      requestId,
    });
  }
  if (ok) {
    return new DuoApiError({
      code: "INVALID_RESPONSE",
      message: `${path} did not return a valid response envelope (HTTP ${status})`,
      status,
      route: path,
      requestId,
    });
  }
  return new DuoApiError({ code: `HTTP_${status}`, message: `${path} failed with HTTP ${status}`, status, route: path, requestId });
}

/**
 * Creates a client for https://api.duoleads.com. Pass `account` to pay with your own wallet
 * (USDC on Base via x402). The client refuses any price above `maxPriceUsd` before it signs.
 */
export function createClient(options: DuoClientOptions = {}): DuoClient {
  if ((options.account !== undefined) === (options.fetch !== undefined)) {
    throw new TypeError("createClient needs exactly one of `account` (pays with your wallet) or `fetch` (a fetch that already pays)");
  }
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const maxPriceUsd = options.maxPriceUsd ?? DEFAULT_MAX_PRICE_USD;
  const userAgent = options.userAgent ?? SDK_USER_AGENT;
  if (/[\r\n]/.test(userAgent)) throw new TypeError("userAgent must not contain line breaks");
  const maxAtomic = usdToAtomic(maxPriceUsd);
  const payingFetch: FetchLike =
    options.account !== undefined ? buildPayingFetch(options.account, maxAtomic, maxPriceUsd, options.payTo === undefined ? DEFAULT_PAY_TO : options.payTo) : (options.fetch as FetchLike);

  const callPaid = async <T>(path: string, params: object = {}): Promise<PaidResult<T>> => {
    assertRoutePath(path);
    const query = buildQuery(params);
    const headers: Record<string, string> = { accept: "application/json" };
    if (canSetUserAgent() && userAgent) headers["user-agent"] = userAgent;
    const response = await payingFetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, { method: "GET", headers });
    const body = parseJson(await response.text());
    if (response.ok && isRecord(body) && body.ok === true && "data" in body) {
      return { data: body.data as T, meta: isRecord(body.meta) ? body.meta : {}, receipt: receiptOf(response) };
    }
    throw apiError(path, response.status, response.ok, body);
  };

  const callRoute: CallRoute = async <T>(path: string, params: object): Promise<T> => (await callPaid<T>(path, params)).data;
  const generated = createGeneratedClient(callRoute);

  return {
    ...generated,
    call: <T = unknown>(path: string, params?: object) => callRoute<T>(path, params ?? {}),
    callWithReceipt: <T = unknown>(path: string, params?: object) => callPaid<T>(path, params ?? {}),
    checkCounterparty: (input: CounterpartyInput) => checkCounterparty(generated, input),
    derivs: createDerivsClient({
      ...(options.account !== undefined ? { account: options.account } : { fetch: options.fetch as FetchLike }),
      ...(options.payTo !== undefined ? { payTo: options.payTo } : {}),
      userAgent,
      ...(options.derivs?.baseUrl !== undefined ? { baseUrl: options.derivs.baseUrl } : {}),
      ...(options.derivs?.maxPriceUsd !== undefined ? { maxPriceUsd: options.derivs.maxPriceUsd } : {}),
    }),
  };
}
