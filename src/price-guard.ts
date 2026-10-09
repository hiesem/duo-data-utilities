import { x402Client, x402HTTPClient, type PaymentPolicy, type PaymentRequired, type PaymentRequirements } from "@x402/fetch";
import { PriceGuardError } from "./errors.js";

/** Base mainnet in CAIP-2 form. The only network the client will pay on. */
export const BASE_NETWORK = "eip155:8453";
/** USD Coin on Base, the only asset the client will pay in. */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Largest price the client signs for one call, in USD. Every route costs $0.05. */
export const DEFAULT_MAX_PRICE_USD = 0.05;
/** The service's public receiving address. By default the client signs payments to this address only. */
export const DEFAULT_PAY_TO = "0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39";

/** USD to atomic USDC units (6 decimals), rounded to the nearest unit. */
export function usdToAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError(`maxPriceUsd must be a positive number, got ${usd}`);
  const atomic = BigInt(Math.round(usd * 1_000_000));
  if (atomic < 1n) throw new RangeError("maxPriceUsd must be at least 0.000001 (one USDC base unit)");
  return atomic;
}

/** Atomic USDC units as a dollar string, e.g. 50000n is "$0.05". */
export function formatUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${fraction}`;
}

/** Why one payment requirement is refused, or null when it may be signed. */
export function requirementProblem(
  requirement: Partial<PaymentRequirements>,
  maxAtomic: bigint,
  payTo: string | null = DEFAULT_PAY_TO,
): string | null {
  if (requirement.scheme !== "exact") return `scheme ${JSON.stringify(requirement.scheme ?? null)} is not "exact"`;
  if (requirement.network !== BASE_NETWORK) {
    return `network ${JSON.stringify(requirement.network ?? null)} is not ${BASE_NETWORK} (Base)`;
  }
  if (typeof requirement.asset !== "string" || requirement.asset.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) {
    return `asset ${JSON.stringify(requirement.asset ?? null)} is not Base USDC (${BASE_USDC_ADDRESS})`;
  }
  if (typeof requirement.amount !== "string" || !/^[0-9]+$/.test(requirement.amount)) {
    return `amount ${JSON.stringify(requirement.amount ?? null)} is not an integer in atomic USDC units`;
  }
  if (payTo !== null && (typeof requirement.payTo !== "string" || requirement.payTo.toLowerCase() !== payTo.toLowerCase())) {
    return `payTo ${JSON.stringify(requirement.payTo ?? null)} is not the expected payee ${payTo}`;
  }
  const amount = BigInt(requirement.amount);
  if (amount === 0n) return "amount is zero";
  if (amount > maxAtomic) {
    return `amount ${requirement.amount} atomic units (${formatUsd(amount)}) is above the maximum ${formatUsd(maxAtomic)}`;
  }
  return null;
}

// Decodes PAYMENT-REQUIRED the same way the payment layer does. No schemes are needed to decode.
const decoder = new x402HTTPClient(new x402Client());

/**
 * Checks the 402 challenge of an unpaid request before the payment layer may sign.
 * A challenge with no acceptable option throws PriceGuardError, and nothing is signed.
 * Paid retries (they carry a payment signature) are passed through unchecked.
 */
export function guardChallenges(
  transport: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  maxAtomic: bigint,
  maxPriceUsd: number,
  payTo: string | null = DEFAULT_PAY_TO,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await transport(request);
    const isPaidRetry = request.headers.has("payment-signature") || request.headers.has("x-payment");
    if (response.status !== 402 || isPaidRetry) return response;

    let required: PaymentRequired;
    try {
      let body: unknown;
      if (!response.headers.get("PAYMENT-REQUIRED")) body = await response.clone().json().catch(() => undefined);
      required = decoder.getPaymentRequiredResponse((name) => response.headers.get(name), body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PriceGuardError([`the payment requirements could not be read: ${reason}`], maxPriceUsd);
    }

    const reasons: string[] = [];
    if (required.x402Version !== 2) reasons.push(`x402Version ${String(required.x402Version)} is not 2`);
    const options = Array.isArray(required.accepts) ? required.accepts : [];
    const problems = options.map((option) => requirementProblem(option, maxAtomic, payTo));
    if (options.length === 0) reasons.push("the challenge offers no payment option");
    else if (problems.every((problem) => problem !== null)) reasons.push(...(problems as string[]));
    if (reasons.length > 0) throw new PriceGuardError(reasons, maxPriceUsd);
    return response;
  };
}

/**
 * Policy for the x402 client. It keeps only the requirements the guard accepts, so the
 * payment layer cannot select a refused option.
 */
export function guardPolicy(maxAtomic: bigint, payTo: string | null = DEFAULT_PAY_TO): PaymentPolicy {
  return (_version, requirements) => requirements.filter((requirement) => requirementProblem(requirement, maxAtomic, payTo) === null);
}
