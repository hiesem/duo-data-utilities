// R64-PA-01: by default every route is capped at its own listed price, on all four services (33 + 44 + 10 + 26
// routes, each in its own HTTP method, GET or POST): the listed price is signed, the listed price + 1 atomic unit
// is refused before anything is signed. An explicit maxPriceUsd stays the override.
// Independent authority for the prices and methods: the committed production snapshots spec/manifest.json (main)
// and spec/{keywords,derivs,social}-openapi.json (x-payment-info), not the generated route tables under test.
// Loopback mock server and a throwaway signer: nothing touches the network and nothing is paid.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, createDerivsClient, createKeywordsClient, createSocialClient, PriceGuardError, type EvmSigner } from "../src/index.js";
import { challengeHeader, PAY_TO, paymentResponseHeader, type Requirement } from "./helpers/challenge.js";
import { startMockServer, type MockReply, type MockServer } from "./helpers/mock-server.js";

const spec = (file: string) => JSON.parse(readFileSync(new URL(`../spec/${file}`, import.meta.url), "utf8"));

/** A decimal USD string as atomic USDC, exactly (no float). */
function atomic(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd);
  if (!m) throw new Error(`not a USD amount: ${usd}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

interface Listed {
  path: string;
  method: string;
  amount: bigint;
}
function fromOpenApi(file: string): Listed[] {
  const paths = spec(file).paths as Record<string, Record<string, { "x-payment-info": { price: { amount: string; currency: string } } }>>;
  return Object.entries(paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => {
      expect(op["x-payment-info"].price.currency, path).toBe("USD");
      return { path, method: method.toUpperCase(), amount: atomic(op["x-payment-info"].price.amount) };
    }),
  );
}
const manifest = spec("manifest.json").data as { price_usd: string; routes: Array<{ path: string; method: string; price_usd?: string }> };
const LISTED: Record<"main" | "keywords" | "derivs" | "social", Listed[]> = {
  main: manifest.routes.map((r) => ({ path: r.path, method: r.method, amount: atomic(r.price_usd ?? manifest.price_usd) })),
  keywords: fromOpenApi("keywords-openapi.json"),
  derivs: fromOpenApi("derivs-openapi.json"),
  social: fromOpenApi("social-openapi.json"),
};

let offered = new Map<string, bigint>();
let server: MockServer;
beforeAll(async () => {
  server = await startMockServer((r): MockReply => {
    if (!r.paymentSignature) {
      return {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challengeHeader((c) => {
            (c.accepts[0] as Requirement).amount = String(offered.get(r.path) ?? 0n);
            c.resource = { url: `https://example.invalid${r.path}`, mimeType: "application/json" };
            delete c.extensions;
          }),
        },
      };
    }
    // main answers in its envelope, the other three with the data object itself
    return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(PAY_TO) }, body: { ok: true, data: { x: 1 }, meta: {} } };
  });
});
afterAll(() => server.close());

function spySigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signTypedData = vi.fn((message: unknown) => account.signTypedData(message as Parameters<typeof account.signTypedData>[0]));
  return { signer: { address: account.address, signTypedData } as unknown as EvmSigner, signTypedData };
}
const signedValue = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")).payload.authorization.value as string;

type Caller = { call(path: string, params?: object): Promise<unknown> };
type Make = (signer: EvmSigner, maxPriceUsd?: number) => Caller;
const STANDALONE: Record<keyof typeof LISTED, Make> = {
  main: (account, maxPriceUsd) => createClient({ account, baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) }),
  keywords: (account, maxPriceUsd) => createKeywordsClient({ account, baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) }),
  derivs: (account, maxPriceUsd) => createDerivsClient({ account, baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) }),
  social: (account, maxPriceUsd) => createSocialClient({ account, baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) }),
};
// The same clients as createClient(...).keywords / .derivs / .social, with the sub-client's own maxPriceUsd.
const SUB: Record<"keywords" | "derivs" | "social", Make> = {
  keywords: (account, maxPriceUsd) => createClient({ account, keywords: { baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) } }).keywords,
  derivs: (account, maxPriceUsd) => createClient({ account, derivs: { baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) } }).derivs,
  social: (account, maxPriceUsd) => createClient({ account, social: { baseUrl: server.baseUrl, ...(maxPriceUsd ? { maxPriceUsd } : {}) } }).social,
};

async function assertPerRouteCaps(make: Make, routes: Listed[]): Promise<void> {
  const { signer, signTypedData } = spySigner();
  const client = make(signer);
  for (const r of routes) {
    offered = new Map([[r.path, r.amount]]);
    const before = server.requests.length;
    await client.call(r.path, {});
    const sent = server.requests.slice(before);
    expect(sent.map((q) => q.method), r.path).toEqual([r.method, r.method]);
    expect(signedValue(sent[1]!.paymentSignature), r.path).toBe(String(r.amount));

    offered = new Map([[r.path, r.amount + 1n]]);
    const signs = signTypedData.mock.calls.length;
    const at = server.requests.length;
    await expect(client.call(r.path, {}), `${r.path} at listed + 1`).rejects.toBeInstanceOf(PriceGuardError);
    expect(signTypedData.mock.calls.length, `${r.path} signed nothing`).toBe(signs);
    expect(server.requests.slice(at).filter((q) => q.paymentSignature !== null), r.path).toHaveLength(0);
  }
}

describe("per-route default caps (R64-PA-01)", () => {
  it("lists 33 + 44 + 10 + 26 routes in the snapshots, GET and POST among them", () => {
    expect([LISTED.main.length, LISTED.keywords.length, LISTED.derivs.length, LISTED.social.length]).toEqual([33, 44, 10, 26]);
    expect(new Set(LISTED.keywords.map((r) => r.method))).toEqual(new Set(["GET", "POST"]));
  });

  for (const service of ["main", "keywords", "derivs", "social"] as const) {
    it(`${service}: every route signs its listed price and refuses listed + 1 before signing`, async () => {
      await assertPerRouteCaps(STANDALONE[service], LISTED[service]);
    });
  }
  for (const service of ["keywords", "derivs", "social"] as const) {
    it(`createClient(...).${service}: the same per-route caps`, async () => {
      await assertPerRouteCaps(SUB[service], LISTED[service]);
    });
  }

  it("an explicit maxPriceUsd overrides the per-route caps, upwards and downwards", async () => {
    const cases: Array<[keyof typeof LISTED, string, number, bigint, boolean]> = [
      ["main", "/v1/id/iban", 0.06, 60_000n, true],
      ["main", "/v1/id/iban", 0.04, 50_000n, false],
      ["keywords", "/v1/search-volume", 0.05, 45_000n, true],
      ["keywords", "/v1/related-queries", 0.045, 45_000n, true],
      ["keywords", "/v1/trend", 0.04, 45_000n, false],
      ["derivs", "/v1/funding-rates", 0.005, 5_000n, true],
      ["derivs", "/v1/derivatives-snapshot", 0.003, 5_000n, false],
      ["social", "/v1/bluesky/search", 0.025, 25_000n, true],
      ["social", "/v1/social/search", 0.01, 25_000n, false],
    ];
    for (const [service, path, max, amount, pays] of cases) {
      const { signer, signTypedData } = spySigner();
      offered = new Map([[path, amount]]);
      const call = STANDALONE[service](signer, max).call(path, {});
      if (pays) await call;
      else await expect(call, `${service} ${path}`).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData, `${service} ${path}`).toHaveBeenCalledTimes(pays ? 1 : 0);
      if (service !== "main") {
        const { signer: s2, signTypedData: sign2 } = spySigner();
        const sub = SUB[service](s2, max).call(path, {});
        if (pays) await sub;
        else await expect(sub).rejects.toBeInstanceOf(PriceGuardError);
        expect(sign2).toHaveBeenCalledTimes(pays ? 1 : 0);
      }
    }
  });

  it("a path the client does not know keeps the service-wide default cap", async () => {
    const { signer } = spySigner();
    offered = new Map([["/v1/not-listed", 5_000n]]);
    await createDerivsClient({ account: signer, baseUrl: server.baseUrl }).call("/v1/not-listed", {});
    offered = new Map([["/v1/not-listed", 5_001n]]);
    await expect(createDerivsClient({ account: signer, baseUrl: server.baseUrl }).call("/v1/not-listed", {})).rejects.toBeInstanceOf(PriceGuardError);
  });
});
