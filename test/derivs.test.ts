// The derivs client (https://derivs.duoleads.com) against a loopback mock server and a fake fetch.
// Nothing touches the network and nothing is paid: the 402 challenges are mocked, the signer is a
// throwaway account generated at run time.
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createClient,
  createDerivsClient,
  DEFAULT_DERIVS_MAX_PRICE_USD,
  DERIVS_MCP_URL,
  DERIVS_ROUTES,
  DuoApiError,
  PriceGuardError,
  SDK_USER_AGENT,
  type EvmSigner,
} from "../src/index.js";
import { buildDerivsQuery } from "../src/derivs.js";
import { BASE_USDC, derivsChallengeHeader, derivsSpec, jsonResponse, PAY_TO, paymentResponseHeader, type Requirement } from "./helpers/challenge.js";
import { startMockServer, type MockReply } from "./helpers/mock-server.js";

function spySigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signTypedData = vi.fn((message: unknown) => account.signTypedData(message as Parameters<typeof account.signTypedData>[0]));
  const signer = { address: account.address, signTypedData } as unknown as EvmSigner;
  return { account, signer, signTypedData };
}

function decodePaymentSignature(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepted: Requirement;
    payload: { authorization: { from: string; to: string; value: string } };
  };
}

const example = (path: string) => derivsSpec.routes.find((r) => r.path === path)?.outputExample ?? {};
const amountOf = (path: string) => derivsSpec.routes.find((r) => r.path === path)?.amount ?? "0";

/** A mock derivs server: 402 with the route's price until a payment arrives, then the route's real output example. */
async function derivsServer(amountFor: (path: string) => string = amountOf) {
  return startMockServer((request): MockReply => {
    if (!request.paymentSignature) return { status: 402, headers: { "PAYMENT-REQUIRED": derivsChallengeHeader(request.path, amountFor(request.path)) } };
    return { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader(PAY_TO) }, body: example(request.path) };
  });
}

function fakeFetch(reply: (url: URL) => Response = (url) => jsonResponse(example(url.pathname))) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return reply(url);
  };
  return { calls, fetchImpl };
}

describe("derivs route table", () => {
  it("has the 10 routes of the snapshot, at $0.003 (3000) or $0.005 (5000)", () => {
    expect(DERIVS_ROUTES).toHaveLength(10);
    expect(DERIVS_ROUTES.map((r) => r.path)).toEqual(derivsSpec.routes.map((r) => r.path));
    const fiveThousand = DERIVS_ROUTES.filter((r) => r.amount === "5000").map((r) => r.path);
    expect(fiveThousand).toEqual(["/v1/funding-arbitrage", "/v1/perp-screener", "/v1/derivatives-snapshot"]);
    expect(DERIVS_ROUTES.filter((r) => r.amount === "3000")).toHaveLength(7);
    for (const r of DERIVS_ROUTES) expect(r.priceUsd).toBe(r.amount === "5000" ? "0.005" : "0.003");
  });

  it("defaults to a $0.005 cap and the derivs MCP endpoint", () => {
    expect(DEFAULT_DERIVS_MAX_PRICE_USD).toBe(0.005);
    expect(DERIVS_MCP_URL).toBe("https://derivs.duoleads.com/mcp");
  });

  it("maps every method to its path and query, on https://derivs.duoleads.com", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createDerivsClient({ fetch: fetchImpl }) as unknown as Record<string, (p: object) => Promise<unknown>>;
    for (const route of DERIVS_ROUTES) {
      const input = derivsSpec.routes.find((r) => r.path === route.path)?.inputExample ?? {};
      const data = await client[route.method]?.(input);
      expect(data, route.path).toEqual(example(route.path));
      const last = calls.at(-1);
      expect(last?.url.origin).toBe("https://derivs.duoleads.com");
      expect(last?.url.pathname).toBe(route.path);
      expect(Object.fromEntries(last?.url.searchParams ?? [])).toEqual(input);
      expect(last?.init?.method).toBe("GET");
    }
    expect(calls).toHaveLength(10);
  });

  it("accepts no arguments for the routes without required parameters", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createDerivsClient({ fetch: fetchImpl });
    await client.fundingArbitrage();
    await client.perpScreener();
    expect(calls.map((c) => c.url.href)).toEqual(["https://derivs.duoleads.com/v1/funding-arbitrage", "https://derivs.duoleads.com/v1/perp-screener"]);
  });
});

describe("paying derivs routes with a wallet (mocked 402)", () => {
  it("pays the $0.003 challenge of funding-rates once, to the service address", async () => {
    const { account, signer, signTypedData } = spySigner();
    const server = await derivsServer();
    try {
      const client = createDerivsClient({ account: signer, baseUrl: server.baseUrl });
      const result = await client.callWithReceipt("/v1/funding-rates", { coin: "BTC" });
      expect(result.data).toEqual(example("/v1/funding-rates"));
      expect(result.receipt).toMatchObject({ success: true, network: "eip155:8453" });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(server.requests.map((r) => r.search)).toEqual(["?coin=BTC", "?coin=BTC"]);
      const signed = decodePaymentSignature(server.requests[1]?.paymentSignature ?? "");
      expect(signed.payload.authorization).toMatchObject({ from: account.address, to: PAY_TO, value: "3000" });
      expect(signed.accepted).toMatchObject({ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: PAY_TO });
    } finally {
      await server.close();
    }
  });

  it("pays the $0.005 challenge of derivatives-snapshot through the typed method", async () => {
    const { signer } = spySigner();
    const server = await derivsServer();
    try {
      const snapshot = await createDerivsClient({ account: signer, baseUrl: server.baseUrl }).derivativesSnapshot({ coin: "ETH" });
      expect(snapshot.coin).toBe("BTC"); // the mock answers with the recorded BTC example
      expect(decodePaymentSignature(server.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("5000");
    } finally {
      await server.close();
    }
  });

  it("refuses $0.006 by default and signs nothing", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await derivsServer(() => "6000");
    try {
      const client = createDerivsClient({ account: signer, baseUrl: server.baseUrl });
      const error = await client.fundingRates({ coin: "BTC" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PriceGuardError);
      expect(String((error as Error).message)).toMatch(/above the maximum \$0\.005/);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(server.requests.every((r) => r.paymentSignature === null)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("with maxPriceUsd 0.003 pays the $0.003 routes and refuses the $0.005 ones", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await derivsServer();
    try {
      const client = createDerivsClient({ account: signer, baseUrl: server.baseUrl, maxPriceUsd: 0.003 });
      await client.openInterest({ coin: "BTC" });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      await expect(client.fundingArbitrage({ min_apr: 10 })).rejects.toThrow(/5000 atomic units \(\$0\.005\) is above the maximum \$0\.003/);
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["another payee", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).payTo = "0x0000000000000000000000000000000000000002")],
    ["a testnet network", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).network = "eip155:84532")],
    ["a non-USDC asset", (c: { accepts: Requirement[] }) => ((c.accepts[0] as Requirement).asset = "0x0000000000000000000000000000000000000001")],
  ])("refuses %s without signing", async (_label, edit) => {
    const { signer, signTypedData } = spySigner();
    const server = await startMockServer((request): MockReply => ({
      status: 402,
      headers: { "PAYMENT-REQUIRED": derivsChallengeHeader(request.path, "3000", edit) },
    }));
    try {
      await expect(createDerivsClient({ account: signer, baseUrl: server.baseUrl }).basis({ coin: "BTC" })).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("client.derivs from createClient uses the derivs cap, not the main $0.05 cap", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await derivsServer((path) => (path === "/v1/orderbook" ? "6000" : amountOf(path)));
    try {
      const client = createClient({ account: signer, derivs: { baseUrl: server.baseUrl } });
      // 6000 is refused although the main API's cap is 50000: client.derivs has its own $0.005 cap.
      await expect(client.derivs.orderbook({ coin: "BTC", size_usd: 100000 })).rejects.toThrow(/above the maximum \$0\.005/);
      expect(signTypedData).not.toHaveBeenCalled();
      const rates = await client.derivs.call("/v1/funding-rates", { coin: "BTC" });
      expect(rates).toEqual(example("/v1/funding-rates"));
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("client.derivs pays a $0.005 route and honours derivs.maxPriceUsd", async () => {
    const { signer, signTypedData } = spySigner();
    const server = await derivsServer();
    try {
      const client = createClient({ account: signer, derivs: { baseUrl: server.baseUrl } });
      await client.derivs.perpScreener({ sort: "oi", limit: 10 });
      expect(server.requests[0]?.search).toBe("?sort=oi&limit=10");
      expect(decodePaymentSignature(server.requests[1]?.paymentSignature ?? "").payload.authorization.value).toBe("5000");
      const capped = createClient({ account: signer, derivs: { baseUrl: server.baseUrl, maxPriceUsd: 0.003 } });
      await expect(capped.derivs.perpScreener()).rejects.toBeInstanceOf(PriceGuardError);
      expect(signTypedData).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("sends the SDK User-Agent on the unpaid request and the paid retry", async () => {
    const { signer } = spySigner();
    const server = await derivsServer();
    try {
      await createDerivsClient({ account: signer, baseUrl: server.baseUrl }).liquidations({ coin: "BTC", hours: 4 });
      expect(server.requests.map((r) => r.userAgent)).toEqual([SDK_USER_AGENT, SDK_USER_AGENT]);
    } finally {
      await server.close();
    }
  });
});

describe("derivs errors and inputs", () => {
  it("throws DuoApiError with code, param, expected and request id from the error body", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        { error: { status: 400, code: "INVALID_PARAM", message: "Unknown coin. Nothing was charged.", param: "coin", expected: "a coin symbol, e.g. BTC" }, request_id: "01KTEST" },
        { status: 400 },
      ),
    );
    const error = await createDerivsClient({ fetch: fetchImpl }).fundingRates({ coin: "??" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuoApiError);
    expect(error).toMatchObject({ code: "INVALID_PARAM", param: "coin", expected: "a coin symbol, e.g. BTC", status: 400, route: "/v1/funding-rates", requestId: "01KTEST" });
  });

  it("reports a 503 'nothing was charged' answer as DuoApiError", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ error: { status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Only 2 of 8 venues answered; nothing was charged." } }, { status: 503 }),
    );
    await expect(createDerivsClient({ fetch: fetchImpl }).openInterest({ coin: "BTC" })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 503 });
  });

  it("reports PAYMENT_REQUIRED, INVALID_RESPONSE and HTTP_<status>", async () => {
    await expect(createDerivsClient({ fetch: fakeFetch(() => new Response("", { status: 402 })).fetchImpl }).basis({ coin: "BTC" })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    await expect(createDerivsClient({ fetch: fakeFetch(() => new Response("<html>", { status: 200 })).fetchImpl }).basis({ coin: "BTC" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(createDerivsClient({ fetch: fakeFetch(() => new Response("down", { status: 502 })).fetchImpl }).basis({ coin: "BTC" })).rejects.toMatchObject({ code: "HTTP_502" });
  });

  it("writes numbers as plain decimals, never in exponent form", () => {
    expect(buildDerivsQuery({ min_volume_usd: 1e12, fee_pct: 1e-7, limit: 20, coin: "BTC", skip: undefined })).toBe(
      "min_volume_usd=1000000000000&fee_pct=0.0000001&limit=20&coin=BTC",
    );
    expect(() => buildDerivsQuery({ limit: Number.NaN })).toThrow(TypeError);
    expect(() => buildDerivsQuery({ coins: ["BTC"] })).toThrow(TypeError);
  });

  it("refuses anything that is not a derivs route path, before any request", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createDerivsClient({ fetch: fetchImpl });
    for (const path of ["/mcp", "/v1/id/iban", "/v1/../mcp", "https://evil.example/v1/basis", "/v1/Basis"]) {
      await expect(client.call(path), path).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("needs exactly one of account or fetch, and https outside localhost", () => {
    expect(() => createDerivsClient()).toThrow(TypeError);
    expect(() => createDerivsClient({ fetch: fakeFetch().fetchImpl, baseUrl: "http://derivs.example.com" })).toThrow(/must use https/);
    expect(() => createDerivsClient({ fetch: fakeFetch().fetchImpl, maxPriceUsd: 0 })).toThrow(RangeError);
  });
});
