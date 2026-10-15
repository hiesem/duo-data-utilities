# MCP configuration

The MCP server is at `https://api.duoleads.com/mcp` (Streamable HTTP, JSON-RPC over POST).

- `tools/list` is free.
- `tools/call` costs $0.05 per call, paid in USDC on Base (`eip155:8453`) with x402 v2. The payment goes in the request's `_meta` under `x402/payment` (the x402 MCP convention, as implemented by `@x402/mcp`).
- An unpaid `tools/call` charges nothing. The endpoint answers it with `isError: true` and an x402 v2 payment-required object in the tool result. Malformed arguments return a free tool error and are never charged.

## Which clients can pay

We could not confirm from first-party documentation that any of the clients below pays x402 natively. Each one needs an x402-capable client or wallet bridge to make paid calls. Check your client's documentation before you rely on a setup.

| Client | How to add the server | Payment |
|---|---|---|
| Claude Code | `claude mcp add --transport http duo-data-utilities https://api.duoleads.com/mcp` | Check your client |
| Claude Desktop | `mcp/claude-desktop.json` (uses the `mcp-remote` bridge, npm `mcp-remote`) | Check your client. The bridge only carries the connection. |
| Cursor | Copy `mcp/cursor.mcp.json` to `.cursor/mcp.json` | Check your client |
| VS Code | Copy `mcp/vscode.mcp.json` to `.vscode/mcp.json` | Check your client |
| AgentCash | No snippet. A third-party directory describes it as a stdio MCP server that pays x402 APIs for the agent. Its setup is not verified here. | Check AgentCash's documentation |

`tools/list` works in any MCP client, so you can check the connection before you set up payment.

## Tool names

The 33 tools and the route each one calls. The earlier names (`<group>_<name>`, e.g. `id_iban`) are still accepted by `tools/call` as aliases, but `tools/list` shows only these.

| Tool | Route |
|---|---|
| `iban_validate` | `/v1/id/iban` |
| `iban_generate` | `/v1/id/iban-build` |
| `vat_tax_id_validate` | `/v1/id/national` |
| `isin_cusip_sedol_validate` | `/v1/id/security` |
| `gtin_barcode_validate` | `/v1/id/gs1` |
| `timezone_convert` | `/v1/time/zone` |
| `dst_transitions` | `/v1/time/dst` |
| `business_days_calculate` | `/v1/time/business-days` |
| `rrule_expand` | `/v1/time/rrule` |
| `calendar_convert` | `/v1/time/calendar` |
| `string_similarity` | `/v1/text/similarity` |
| `slug_generate` | `/v1/text/slug` |
| `cyrillic_transliterate` | `/v1/text/transliterate` |
| `unicode_confusables_check` | `/v1/text/unicode` |
| `hash_generate` | `/v1/code/hash` |
| `punycode_convert` | `/v1/code/idn` |
| `jwt_decode` | `/v1/code/jwt` |
| `semver_compare` | `/v1/code/semver` |
| `url_parse` | `/v1/code/url` |
| `geohash_encode_decode` | `/v1/geo/geohash` |
| `plus_code_encode_decode` | `/v1/geo/pluscode` |
| `point_in_polygon` | `/v1/geo/polygon` |
| `geo_distance` | `/v1/geo/distance` |
| `crypto_address_validate` | `/v1/chain/address` |
| `solidity_function_selector` | `/v1/chain/selector` |
| `airport_lookup` | `/v1/ref/airport` |
| `country_lookup` | `/v1/ref/country` |
| `currency_lookup` | `/v1/ref/currency` |
| `nuts_region_lookup` | `/v1/ref/nuts` |
| `money_split` | `/v1/num/allocate` |
| `base_convert` | `/v1/num/radix` |
| `statistics_calculate` | `/v1/num/stats` |
| `number_to_words` | `/v1/num/words` |


## Crypto derivatives MCP server: perp funding rates, open interest, futures basis, implied volatility, liquidations, order book depth

A second MCP server at `https://derivs.duoleads.com/mcp` (Streamable HTTP) serves crypto derivatives data from Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX.

- `tools/list` is free.
- `tools/call` costs **$0.003 or $0.005** per call (table below), paid in USDC on Base with x402 v2, payment in `_meta["x402/payment"]`, to the same address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`.
- Bad arguments are a free tool error. When too few venues answer, the call is not charged.

| Client | How to add the server |
|---|---|
| Claude Code | `claude mcp add --transport http duo-derivs https://derivs.duoleads.com/mcp`, or copy `mcp/derivs.mcp.json` to `.mcp.json` |
| Claude Desktop | `mcp/derivs.claude-desktop.json` (uses the `mcp-remote` bridge) |
| Cursor | Copy `mcp/derivs.cursor.mcp.json` to `.cursor/mcp.json` |
| VS Code | Copy `mcp/derivs.vscode.mcp.json` to `.vscode/mcp.json` |

The same payment caveat applies as above: a paid call needs an x402-capable client or wallet bridge. [`examples/mcp-paid-client`](../examples/mcp-paid-client/) pays derivs tools with `DUO_MCP=derivs` (cap $0.005 per call).

```json
{ "mcpServers": { "duo-derivs": { "type": "http", "url": "https://derivs.duoleads.com/mcp" } } }
```

| Tool | Route | Price |
|---|---|---|
| `perp_funding_rates` | `/v1/funding-rates` | $0.003 |
| `funding_rate_history` | `/v1/funding-history` | $0.003 |
| `funding_arbitrage_scan` | `/v1/funding-arbitrage` | $0.005 |
| `perp_screener` | `/v1/perp-screener` | $0.005 |
| `open_interest` | `/v1/open-interest` | $0.003 |
| `futures_basis` | `/v1/basis` | $0.003 |
| `implied_volatility` | `/v1/options` | $0.003 |
| `liquidations` | `/v1/liquidations` | $0.003 |
| `order_book_depth` | `/v1/orderbook` | $0.003 |
| `derivatives_snapshot` | `/v1/derivatives-snapshot` | $0.005 |
