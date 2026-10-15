// The example agents run here offline: the SDK client gets a fake fetch and the MCP client a fake server.
// Nothing touches the network and nothing is paid. tsconfig.json also typechecks every example file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient } from "../src/index.js";
import { checkSupplier, plannedCalls, type Supplier } from "../examples/supplier-onboarding-agent/agent.js";
import { createMcpClient } from "../examples/mcp-paid-client/mcp-agent.js";
import { envelope, fixtureChallenge, jsonResponse, PAY_TO } from "./helpers/challenge.js";

const suppliers = JSON.parse(
  readFileSync(new URL("../examples/supplier-onboarding-agent/suppliers.example.json", import.meta.url), "utf8"),
) as Supplier[];

/** Canned API answers for the sample suppliers, keyed by route. Mirrors the real response shapes. */
function fakeApi(url: URL): Response {
  const q = url.searchParams;
  switch (url.pathname) {
    case "/v1/id/iban-build":
      return jsonResponse(envelope(url.pathname, { iban: "DE89370400440532013000", iban_print: "DE89 3704 0044 0532 0130 00", country: "DE", check_digits: "89", bban: "370400440532013000", parts: { bank: "37040044", branch: null, account: "0532013000" }, length: 22, valid: true }));
    case "/v1/id/iban": {
      const iban = (q.get("iban") ?? "").replace(/\s/g, "");
      const valid = iban !== "NL91ABNA0417164301";
      return jsonResponse(envelope(url.pathname, { valid, iban, iban_print: iban, country: iban.slice(0, 2), check_digits: iban.slice(2, 4), bban: iban.slice(4), parts: { bank: valid ? iban.slice(4, 8) : null, branch: null, account: null }, length: iban.length, expected_length: iban.length, reason: valid ? null : "checksum", algorithm: "mod-97-10" }));
    }
    case "/v1/id/national":
      return jsonResponse(envelope(url.pathname, { valid: true, country: q.get("country"), kind: q.get("kind"), algorithm: "mod-97", normalised: q.get("value"), formatted: q.get("value"), reason: null, derived: {} }));
    case "/v1/text/similarity":
      return jsonResponse(envelope(url.pathname, { jaro_winkler: q.get("b") === "Mario Rossi" ? 0.45 : 0.97, equal_after_fold: false, folded: { a: q.get("a"), b: q.get("b") } }));
    default:
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "no such route" } }, { status: 404 });
  }
}

describe("examples/supplier-onboarding-agent", () => {
  it("plans 11 paid calls ($0.55) for the sample file", () => {
    expect(suppliers.flatMap(plannedCalls)).toHaveLength(11);
  });

  it("approves, rejects and flags the sample suppliers as documented", async () => {
    const seen: string[] = [];
    const client = createClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        seen.push(url.pathname);
        return fakeApi(url);
      },
    });
    const reports = [];
    for (const supplier of suppliers) reports.push(await checkSupplier(client, supplier));
    expect(reports.map((r) => [r.id, r.decision])).toEqual([
      ["SUP-001", "approve"],
      ["SUP-002", "approve"],
      ["SUP-003", "reject"],
      ["SUP-004", "review"],
    ]);
    expect(reports[1]?.iban).toBe("DE89370400440532013000");
    expect(seen).toEqual(suppliers.flatMap(plannedCalls));
    expect(reports.reduce((sum, r) => sum + r.paidCalls, 0)).toBe(11);
  });
});

describe("examples/mcp-paid-client", () => {
  type Rpc = { method: string; params?: { name?: string; _meta?: Record<string, unknown> } };

  function fakeMcpServer(edit?: (challenge: ReturnType<typeof fixtureChallenge>) => void) {
    const calls: Rpc[] = [];
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      const rpc = JSON.parse(String(init.body)) as Rpc & { id: number };
      calls.push(rpc);
      const reply = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "tools/list") return reply({ tools: [{ name: "iban_validate", title: "IBAN validator", inputSchema: {} }] });
      if (rpc.method !== "tools/call") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "0" } });
      if (!rpc.params?._meta?.["x402/payment"]) {
        const challenge = fixtureChallenge();
        edit?.(challenge);
        return reply({ isError: true, structuredContent: challenge, content: [{ type: "text", text: JSON.stringify(challenge) }] });
      }
      return reply({ structuredContent: { valid: true }, content: [], _meta: { "x402/payment-response": { success: true, transaction: `0x${"ab".repeat(32)}` } } });
    };
    return { calls, fetchImpl };
  }

  it("lists tools for free and pays a tool call once, to the service address, for at most $0.05", async () => {
    const server = fakeMcpServer();
    const client = createMcpClient({ signer: privateKeyToAccount(generatePrivateKey()), fetch: server.fetchImpl });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["iban_validate"]);
    const { result, receipt } = await client.callTool("iban_validate", { iban: "NL91 ABNA 0417 1643 00" });
    expect(result.structuredContent).toEqual({ valid: true });
    expect(receipt).toMatchObject({ success: true });
    const paid = server.calls.at(-1)?.params?._meta?.["x402/payment"] as { x402Version: number; payload: { authorization: { to: string; value: string } } };
    expect(paid.x402Version).toBe(2);
    expect(paid.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(BigInt(paid.payload.authorization.value)).toBeLessThanOrEqual(50_000n);
  });

  it("refuses a price above $0.05 and signs nothing", async () => {
    const server = fakeMcpServer((challenge) => {
      for (const option of challenge.accepts) option.amount = "60000";
    });
    const client = createMcpClient({ signer: privateKeyToAccount(generatePrivateKey()), fetch: server.fetchImpl });
    await expect(client.callTool("iban_validate", { iban: "x" })).rejects.toThrow(/refused to pay/);
    expect(server.calls.filter((c) => c.method === "tools/call")).toHaveLength(1);
  });
});

describe("examples/funding-arbitrage-watcher", () => {
  it("states its cost upfront: 12 scans at $0.005 = $0.06 by default", async () => {
    const { DEFAULTS, plan, parseArgs, PRICE_USD } = await import("../examples/funding-arbitrage-watcher/watcher.js");
    expect(PRICE_USD).toBe(0.005);
    expect(plan(DEFAULTS)).toEqual({ calls: 12, maxCostUsd: 0.06, durationMin: 55 });
    expect(parseArgs(["--scans", "4", "--min-net-apr", "30", "--dry-run"])).toMatchObject({ scans: 4, minNetApr: 30, dryRun: true });
    expect(() => parseArgs(["--scans", "0"])).toThrow();
    expect(() => parseArgs(["--bogus", "1"])).toThrow();
  });

  it("scans once per interval, alerts each new opportunity once, and skips unpaid 503 scans", async () => {
    const { runWatcher, DEFAULTS } = await import("../examples/funding-arbitrage-watcher/watcher.js");
    const { createDerivsClient } = await import("../src/index.js");
    const { derivsSpec } = await import("./helpers/challenge.js");
    const recorded = derivsSpec.routes.find((r) => r.path === "/v1/funding-arbitrage")?.outputExample ?? {};
    const seen: URL[] = [];
    const client = createDerivsClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        seen.push(url);
        if (seen.length === 2) return jsonResponse({ error: { status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Only 2 of 8 venues answered; nothing was charged." } }, { status: 503 });
        return jsonResponse(recorded);
      },
    });
    const sleeps: number[] = [];
    const lines: string[] = [];
    const result = await runWatcher(client, { ...DEFAULTS, scans: 3, intervalMin: 5, minNetApr: 50 }, { sleep: async (ms) => void sleeps.push(ms), log: (l) => lines.push(l) });
    expect(seen.map((u) => u.pathname)).toEqual(["/v1/funding-arbitrage", "/v1/funding-arbitrage", "/v1/funding-arbitrage"]);
    expect(Object.fromEntries(seen[0]?.searchParams ?? [])).toEqual({ min_apr: "50", min_volume_usd: "1000000", fee_pct: "0.05", holding_days: "30", limit: "50" });
    expect(sleeps).toEqual([300_000, 300_000]);
    expect(result.paidScans).toBe(2);
    expect(result.spentUsd).toBeCloseTo(0.01);
    const expected = (recorded as { opportunities: Array<{ coin: string; net_apr_pct: number | null }> }).opportunities.filter((o) => (o.net_apr_pct ?? 0) >= 50);
    expect(expected.length).toBeGreaterThan(0);
    expect(result.alerts.map((a) => a.coin)).toEqual(expected.map((o) => o.coin)); // the third scan repeats them: no new alerts
    expect(result.alerts.every((a) => a.scan === 1)).toBe(true);
    expect(lines.some((l) => l.includes("skipped") && l.includes("nothing was charged"))).toBe(true);
  });
});

describe("examples/mcp-paid-client against the derivs MCP server (mocked)", () => {
  type Rpc = { id: number; method: string; params?: { name?: string; _meta?: Record<string, unknown> } };

  function fakeDerivsMcp(amount: string) {
    const calls: Rpc[] = [];
    const urls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      const rpc = JSON.parse(String(init.body)) as Rpc;
      calls.push(rpc);
      urls.push(url);
      const reply = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method !== "tools/call") return reply({ tools: [] });
      if (!rpc.params?._meta?.["x402/payment"]) {
        const challenge = fixtureChallenge();
        for (const option of challenge.accepts) option.amount = amount;
        challenge.resource = { url: "mcp://tool/perp_funding_rates", mimeType: "application/json" };
        delete challenge.extensions;
        return reply({ isError: true, structuredContent: challenge, content: [] });
      }
      return reply({ structuredContent: { coin: "BTC" }, content: [], _meta: { "x402/payment-response": { success: true } } });
    };
    return { calls, urls, fetchImpl };
  }

  it("pays a $0.003 tool call with the $0.005 derivs cap", async () => {
    const { DERIVS_MCP_URL, DERIVS_MAX_AMOUNT_ATOMIC } = await import("../examples/mcp-paid-client/mcp-agent.js");
    expect(DERIVS_MCP_URL).toBe("https://derivs.duoleads.com/mcp");
    const server = fakeDerivsMcp("3000");
    const client = createMcpClient({ signer: privateKeyToAccount(generatePrivateKey()), fetch: server.fetchImpl, url: DERIVS_MCP_URL, maxAtomic: DERIVS_MAX_AMOUNT_ATOMIC });
    const { result } = await client.callTool("perp_funding_rates", { coin: "BTC" });
    expect(result.structuredContent).toEqual({ coin: "BTC" });
    expect(server.urls.every((u) => u === "https://derivs.duoleads.com/mcp")).toBe(true);
    const paid = server.calls.at(-1)?.params?._meta?.["x402/payment"] as { payload: { authorization: { to: string; value: string } } };
    expect(paid.payload.authorization.value).toBe("3000");
    expect(paid.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
  });

  it("refuses $0.006 under the derivs cap and signs nothing", async () => {
    const { DERIVS_MCP_URL, DERIVS_MAX_AMOUNT_ATOMIC } = await import("../examples/mcp-paid-client/mcp-agent.js");
    const server = fakeDerivsMcp("6000");
    const client = createMcpClient({ signer: privateKeyToAccount(generatePrivateKey()), fetch: server.fetchImpl, url: DERIVS_MCP_URL, maxAtomic: DERIVS_MAX_AMOUNT_ATOMIC });
    await expect(client.callTool("perp_funding_rates", { coin: "BTC" })).rejects.toThrow(/at most \$0\.005/);
    expect(server.calls.filter((c) => c.method === "tools/call")).toHaveLength(1);
  });
});
