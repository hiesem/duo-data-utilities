# x402-crypto-derivatives-data

Crypto derivatives data API for AI agents and trading bots: perp funding rates, funding rate history, funding arbitrage, a perp screener, open interest, futures basis, implied volatility, liquidations and order book depth across Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX. $0.003 or $0.005 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup.

This is the TypeScript client for https://derivs.duoleads.com. It is also part of [`duo-data-utilities`](https://www.npmjs.com/package/duo-data-utilities) (as `client.derivs`); this package has the derivatives client only.

## Install

```sh
npm install x402-crypto-derivatives-data viem
```

`viem` creates the wallet account that pays. Node.js 20 or later.

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "x402-crypto-derivatives-data";

// Your wallet holds USDC on Base. Read the key from the environment, never a literal.
const client = createClient({ account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`) });

const funding = await client.fundingRates({ coin: "BTC" });                          // $0.003
const arb = await client.fundingArbitrage({ min_apr: 10, limit: 20 });              // $0.005
const oi = await client.openInterest({ coin: "ETH" });                              // $0.003
const snapshot = await client.derivativesSnapshot({ coin: "SOL" });                 // $0.005
```

Each method sends one GET, pays the 402 challenge with your wallet and resolves to the JSON answer. `client.callWithReceipt(path, params)` also returns the settlement receipt (transaction hash).

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price ($0.003 or $0.005); `maxPriceUsd: 0.003` sets one cap for every route and refuses the $0.005 routes. A refused call signs nothing and throws `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

A bad input is a free 400, an unknown coin a free 404, and too few venues answering a 503 that is not charged. Errors throw `DuoApiError` with `code`, `param`, `expected` and `requestId`.

## Routes

<!-- routes:derivs:client. -->
| Method | Route | Price | MCP tool | What it returns |
|---|---|---|---|---|
| `client.fundingRates` | `GET /v1/funding-rates` | $0.003 | `perp_funding_rates` | Perp funding rates by exchange (one coin) |
| `client.fundingHistory` | `GET /v1/funding-history` | $0.003 | `funding_rate_history` | Funding rate history (one coin, one venue, up to 30 days) |
| `client.fundingArbitrage` | `GET /v1/funding-arbitrage` | $0.005 | `funding_arbitrage_scan` | Funding arbitrage scanner (all coins) |
| `client.perpScreener` | `GET /v1/perp-screener` | $0.005 | `perp_screener` | Perp screener (every perpetual, sorted) |
| `client.openInterest` | `GET /v1/open-interest` | $0.003 | `open_interest` | Open interest by exchange (one coin) |
| `client.basis` | `GET /v1/basis` | $0.003 | `futures_basis` | Futures basis, term structure and perp premium (one coin) |
| `client.options` | `GET /v1/options` | $0.003 | `implied_volatility` | Implied volatility, skew and max pain (crypto options) |
| `client.liquidations` | `GET /v1/liquidations` | $0.003 | `liquidations` | Liquidations (one coin, last 1-24 h) |
| `client.orderbook` | `GET /v1/orderbook` | $0.003 | `order_book_depth` | Order book depth and slippage (one coin, 8 venues) |
| `client.derivativesSnapshot` | `GET /v1/derivatives-snapshot` | $0.005 | `derivatives_snapshot` | Crypto derivatives snapshot (one coin, one call) |
<!-- /routes -->

`DERIVS_ROUTES` holds this table as data (path, MCP tool, price).

## MCP and plain HTTP

The same 10 tools are a paid MCP server at `https://derivs.duoleads.com/mcp` (Streamable HTTP; `tools/list` is free). Every route also works without this package: an unpaid request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header, and any x402 v2 client can pay it.

## Links

- Docs: https://derivs.duoleads.com/docs
- OpenAPI: https://derivs.duoleads.com/openapi.json
- Machine-readable index: https://derivs.duoleads.com/llms.txt
- Terms: https://derivs.duoleads.com/terms
- Privacy: https://derivs.duoleads.com/privacy

Data only: not investment advice, not a benchmark, not affiliated with any exchange.

## Source

Source: [github.com/hiesem/x402-crypto-derivatives-data](https://github.com/hiesem/x402-crypto-derivatives-data) is a generated mirror of this package from the [duo-data-utilities](https://github.com/hiesem/duo-data-utilities) monorepo (`packages/x402-crypto-derivatives-data`); issues are welcome in either repository.

## License

MIT. See [LICENSE](LICENSE).
