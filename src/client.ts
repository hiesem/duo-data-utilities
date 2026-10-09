import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { assertRoutePath, buildQuery, type CallRoute } from "./caller.js";
import { checkCounterparty, type CounterpartyInput, type CounterpartyResult } from "./counterparty.js";
import { DuoApiError } from "./errors.js";
import { createGeneratedClient, type GeneratedClient } from "./generated.js";
import { BASE_NETWORK, DEFAULT_MAX_PRICE_USD, DEFAULT_PAY_TO, guardChallenges, guardPolicy, usdToAtomic } from "./price-guard.js";

export const DEFAULT_BASE_URL = "https://api.duoleads.com";

/** Decoded PAYMENT-RESPONSE header: whether the payment settled, its transaction hash, network and payer. */
export type SettlementReceipt = ReturnType<typeof decodePaymentResponseHeader>;
/** A viem LocalAccount (from privateKeyToAccount) or any object implementing x402's ClientEvmSigner. */
export type EvmSigner = ConstructorParameters<typeof ExactEvmScheme>[0];

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normaliseBaseUrl(raw: string): string {
  const url = new URL(raw);
  const plainLoopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !plainLoopback) {
    throw new TypeError(`baseUrl must use https (plain http is only allowed for localhost): ${raw}`);
  }
  if (url.search || url.hash) throw new TypeError("baseUrl must not contain a query or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function buildPayingFetch(account: EvmSigner, maxAtomic: bigint, maxPriceUsd: number, payTo: string | null): FetchLike {
  return wrapFetchWithPaymentFromConfig(guardChallenges(globalThis.fetch, maxAtomic, maxPriceUsd, payTo), {
    schemes: [{ network: BASE_NETWORK, client: new ExactEvmScheme(account) }],
    policies: [guardPolicy(maxAtomic, payTo)],
    // A second, independent cap in the payment layer, in USD for the default USDC asset.
    spendControls: { maxAmountPerPayment: maxPriceUsd },
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function receiptOf(response: Response): SettlementReceipt | null {
  const header = response.headers.get("payment-response");
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}

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
  const maxAtomic = usdToAtomic(maxPriceUsd);
  const payingFetch: FetchLike =
    options.account !== undefined ? buildPayingFetch(options.account, maxAtomic, maxPriceUsd, options.payTo === undefined ? DEFAULT_PAY_TO : options.payTo) : (options.fetch as FetchLike);

  const callPaid = async <T>(path: string, params: object = {}): Promise<PaidResult<T>> => {
    assertRoutePath(path);
    const query = buildQuery(params);
    const response = await payingFetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
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
  };
}
