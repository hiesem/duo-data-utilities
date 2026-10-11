# Paid MCP client: call 33 IBAN, VAT, ISIN and other tools over MCP, paying per call with x402 (TypeScript)

A small MCP client for the remote MCP server at `https://api.duoleads.com/mcp` (Streamable HTTP). It shows the whole x402 payment flow for MCP tools in one short file, with no MCP SDK dependency:

1. `initialize` and `tools/list`: free. Lists the 33 tools (`iban_validate`, `vat_tax_id_validate`, `isin_cusip_sedol_validate`, `gtin_barcode_validate`, `timezone_convert`, `geo_distance` and more).
2. `tools/call` without payment: the server answers with `isError: true` and an x402 v2 `PaymentRequired` object. Nothing is charged.
3. The client checks the offer: `exact` scheme, Base (`eip155:8453`), USDC, the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, at most $0.05. It signs a USDC transfer authorization with your wallet and resends the call with the payment in `params._meta["x402/payment"]`.
4. The result comes back with the settlement receipt in `result._meta["x402/payment-response"]`.

Use it as a starting point for an agent that needs MCP tools paid per call, or to test the server before you wire it into an MCP host.

## Cost

`tools/list` is free. Each successful `tools/call` costs **$0.05 in USDC on Base** (x402 v2). An unpaid or malformed call costs nothing. No API key, no signup.

## Setup

```sh
cd examples/mcp-paid-client
npm install
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | only for `call` | 0x-prefixed private key of a Base wallet you control that holds a little USDC. Use a dedicated low-balance wallet and keep the key in the environment. |

## Run

```sh
npx tsx mcp-agent.ts list                                    # free
DUO_PAYER_KEY=0x... npx tsx mcp-agent.ts call iban_validate '{"iban":"NL91 ABNA 0417 1643 00"}'
DUO_PAYER_KEY=0x... npx tsx mcp-agent.ts call vat_tax_id_validate '{"country":"DE","kind":"ustid","value":"DE136695976"}'
DUO_PAYER_KEY=0x... npx tsx mcp-agent.ts call iban_generate '{"country":"DE","bank":"37040044","account":"0532013000"}'
```

## MCP host configuration

`mcp.json` adds the server to MCP hosts that read an `mcpServers` map with HTTP servers (Claude Code project `.mcp.json`, Cursor `.cursor/mcp.json`). Listing tools works in any host. A paid call needs a host or wallet bridge that pays x402. For host-specific files see [mcp/README.md](../../mcp/README.md).

```json
{ "mcpServers": { "duo-data-utilities": { "type": "http", "url": "https://api.duoleads.com/mcp" } } }
```

## In your own agent

`createMcpClient({ signer })` returns `listTools()` and `callTool(name, args)`. `signer` is a viem account (`privateKeyToAccount`) or any x402 `ClientEvmSigner`. Hand the tool list to your model, and route its tool calls through `callTool`.
