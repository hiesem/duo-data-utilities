// Paid MCP client for https://api.duoleads.com/mcp (Streamable HTTP, stateless JSON-RPC).
//
// tools/list is free. tools/call costs $0.05 per call, paid in USDC on Base with x402 v2: the server answers an
// unpaid call with isError and an x402 PaymentRequired object; this client checks it (price, network, asset,
// payee), signs an EIP-3009 USDC authorization with YOUR wallet, and resends the call with the payment in
// params._meta["x402/payment"]. The settlement receipt comes back in result._meta["x402/payment-response"].
//
//   npx tsx mcp-agent.ts list                                                   # free
//   DUO_PAYER_KEY=0x... npx tsx mcp-agent.ts call iban_validate '{"iban":"NL91 ABNA 0417 1643 00"}'   # $0.05
import { pathToFileURL } from "node:url";
import { x402Client, type PaymentPayload, type PaymentRequired } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const MCP_URL = "https://api.duoleads.com/mcp";
/** The service's public receiving address. The client refuses to pay anyone else. */
export const PAY_TO = "0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39";
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** $0.05 in USDC atomic units (6 decimals). */
export const MAX_AMOUNT_ATOMIC = 50_000n;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Signer = ConstructorParameters<typeof ExactEvmScheme>[0];

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const isPaymentRequired = (value: unknown): value is PaymentRequired =>
  typeof value === "object" && value !== null && (value as { x402Version?: unknown }).x402Version === 2 && Array.isArray((value as { accepts?: unknown }).accepts);

/** Keeps only the payment options this client is willing to sign. */
export function acceptableOptions(required: PaymentRequired, maxAtomic = MAX_AMOUNT_ATOMIC): PaymentRequired["accepts"] {
  return required.accepts.filter(
    (option) =>
      option.scheme === "exact" &&
      option.network === BASE_NETWORK &&
      option.asset.toLowerCase() === BASE_USDC.toLowerCase() &&
      option.payTo.toLowerCase() === PAY_TO.toLowerCase() &&
      /^\d+$/.test(option.amount) &&
      BigInt(option.amount) <= maxAtomic,
  );
}

export function createMcpClient(options: { signer?: Signer; url?: string; fetch?: FetchLike; userAgent?: string } = {}) {
  const url = options.url ?? MCP_URL;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const payer = options.signer ? new x402Client().register(BASE_NETWORK, new ExactEvmScheme(options.signer)) : null;
  let nextId = 1;

  async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (options.userAgent) headers["user-agent"] = options.userAgent;
    const response = await doFetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }) });
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method} failed: ${body.error.message} (${body.error.code})`);
    if (body.result === undefined) throw new Error(`${method}: no result (HTTP ${response.status})`);
    return body.result;
  }

  return {
    initialize: () =>
      rpc<{ protocolVersion: string; serverInfo: { name: string; version: string } }>("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "duo-mcp-paid-client-example", version: "1.0.0" },
      }),

    /** Free. */
    listTools: async () => (await rpc<{ tools: McpTool[] }>("tools/list")).tools,

    /** $0.05 when the call succeeds. An unpaid or malformed call charges nothing. */
    async callTool(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; receipt: unknown }> {
      const first = await rpc<ToolResult>("tools/call", { name, arguments: args });
      if (!first.isError || !isPaymentRequired(first.structuredContent)) return { result: first, receipt: null };
      if (!payer) throw new Error(`${name} costs $0.05: pass a signer (DUO_PAYER_KEY) to pay`);

      const required = first.structuredContent;
      const accepts = acceptableOptions(required);
      if (accepts.length === 0) throw new Error(`refused to pay: no option is $0.05 USDC on Base to ${PAY_TO}`);
      const payment: PaymentPayload = await payer.createPaymentPayload({ ...required, accepts });

      const paid = await rpc<ToolResult>("tools/call", { name, arguments: args, _meta: { "x402/payment": payment } });
      return { result: paid, receipt: paid._meta?.["x402/payment-response"] ?? null };
    },
  };
}

async function main(): Promise<void> {
  const [command = "list", tool, argsJson = "{}"] = process.argv.slice(2);
  const key = process.env.DUO_PAYER_KEY;
  const client = createMcpClient({
    signer: key?.startsWith("0x") ? privateKeyToAccount(key as `0x${string}`) : undefined,
    userAgent: "duo-mcp-paid-client-example/1.0 (+https://github.com/hiesem/duo-data-utilities)",
  });

  const server = await client.initialize();
  console.error(`Connected to ${server.serverInfo.name} (MCP ${server.protocolVersion})`);

  if (command === "list") {
    for (const t of await client.listTools()) console.log(`${t.name.padEnd(28)} ${t.title ?? ""}`);
    return;
  }
  if (command === "call" && tool) {
    const { result, receipt } = await client.callTool(tool, JSON.parse(argsJson) as Record<string, unknown>);
    console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
    if (receipt) console.error("Receipt:", JSON.stringify(receipt));
    return;
  }
  throw new Error("usage: mcp-agent.ts list | call <tool_name> '<json arguments>'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
