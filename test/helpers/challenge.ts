import { readFileSync } from "node:fs";
import type { PaymentRequirements } from "@x402/fetch";

/** The address that receives payments. Public, pinned in the service configuration. */
export const PAY_TO = "0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39";
/** USD Coin on Base. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface Fixture {
  response: { headers: Record<string, string>; body: unknown };
}

const fixture = JSON.parse(
  readFileSync(new URL("../../spec/fixtures/iban-402-challenge.json", import.meta.url), "utf8"),
) as Fixture;

export type Requirement = PaymentRequirements;

export interface Challenge {
  x402Version: number;
  accepts: Requirement[];
  [key: string]: unknown;
}

export const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

/** The real PAYMENT-REQUIRED challenge captured from /v1/id/iban (decoded). */
export function fixtureChallenge(): Challenge {
  return JSON.parse(Buffer.from(fixture.response.headers["payment-required"] ?? "", "base64").toString("utf8")) as Challenge;
}

/** Base64 PAYMENT-REQUIRED header for the real challenge, optionally edited first. */
export function challengeHeader(edit?: (challenge: Challenge) => void): string {
  const challenge = fixtureChallenge();
  edit?.(challenge);
  return encodeBase64Json(challenge);
}

/** Base64 PAYMENT-RESPONSE header as a settled payment would return it. */
export function paymentResponseHeader(payer: string): string {
  return encodeBase64Json({
    success: true,
    transaction: `0x${"ab".repeat(32)}`,
    network: "eip155:8453",
    payer,
  });
}

/** A success envelope, the same shape the API returns. */
export function envelope(route: string, data: unknown): unknown {
  return {
    ok: true,
    route,
    version: "1.0.0",
    data,
    meta: {
      request_id: "01TESTREQUEST000000000000",
      computed_at: "2026-10-09T00:00:00.000Z",
      price_usd: "0.05",
      deterministic: true,
      disclaimer: "test fixture",
    },
  };
}

/** A JSON response. Used instead of Response.json, which some Node 20 releases lack. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

