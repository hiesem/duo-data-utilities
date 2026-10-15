// HTTP plumbing shared by the main client (api.duoleads.com) and the derivs client (derivs.duoleads.com).
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BASE_NETWORK, guardChallenges, guardPolicy } from "./price-guard.js";

/** Decoded PAYMENT-RESPONSE header: whether the payment settled, its transaction hash, network and payer. */
export type SettlementReceipt = ReturnType<typeof decodePaymentResponseHeader>;
/** A viem LocalAccount (from privateKeyToAccount) or any object implementing x402's ClientEvmSigner. */
export type EvmSigner = ConstructorParameters<typeof ExactEvmScheme>[0];

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * True outside browsers. In a browser (window or worker) the client sends no User-Agent: most browsers
 * drop it, and one that sends it would trigger a CORS preflight the API does not allow.
 */
export function canSetUserAgent(): boolean {
  const scope = globalThis as Record<string, unknown>;
  return typeof scope.document === "undefined" && typeof scope.WorkerGlobalScope === "undefined";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normaliseBaseUrl(raw: string): string {
  const url = new URL(raw);
  const plainLoopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !plainLoopback) {
    throw new TypeError(`baseUrl must use https (plain http is only allowed for localhost): ${raw}`);
  }
  if (url.search || url.hash) throw new TypeError("baseUrl must not contain a query or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A fetch that pays x402 challenges with `account`, after the price guard has accepted them. */
export function buildPayingFetch(account: EvmSigner, maxAtomic: bigint, maxPriceUsd: number, payTo: string | null): FetchLike {
  return wrapFetchWithPaymentFromConfig(guardChallenges(globalThis.fetch, maxAtomic, maxPriceUsd, payTo), {
    schemes: [{ network: BASE_NETWORK, client: new ExactEvmScheme(account) }],
    policies: [guardPolicy(maxAtomic, payTo)],
    // A second, independent cap in the payment layer, in USD for the default USDC asset.
    spendControls: { maxAmountPerPayment: maxPriceUsd },
  });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function receiptOf(response: Response): SettlementReceipt | null {
  const header = response.headers.get("payment-response");
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}
