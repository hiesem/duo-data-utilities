# x402-crypto-derivatives-data (Python)

Crypto derivatives data API for AI agents and trading bots: perpetual futures funding rates with predicted funding, funding history and a funding arbitrage scanner, a perp screener, open interest, futures basis and term structure, options implied volatility, skew and max pain, liquidations, and order book depth with slippage, across Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX. 10 routes, $0.003 or $0.005 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup.

This is the Python client for https://derivs.duoleads.com. It is also part of [`duo-data-utilities`](https://pypi.org/project/duo-data-utilities/) (as `DuoClient(...).derivs`); this package has the derivs client only and does not depend on it. TypeScript: [`x402-crypto-derivatives-data` on npm](https://www.npmjs.com/package/x402-crypto-derivatives-data).

## Install

```sh
pip install x402-crypto-derivatives-data
```

Python 3.10 or later. `eth-account` (installed with it) creates the wallet account that pays.

## Quick start

```python
import os

from eth_account import Account
from x402_crypto_derivatives_data import DerivsClient

# Your wallet holds USDC on Base. Read the key from the environment, never a literal.
client = DerivsClient(Account.from_key(os.environ["PAYER_KEY"]))

funding = client.funding_rates(coin="BTC")                                    # $0.003
for venue in funding["venues"]:
    print(venue["venue"], venue["apr_pct"], venue["next_funding_time"])
arb = client.funding_arbitrage(min_apr=20, min_volume_usd=1_000_000)         # $0.005, all coins
book = client.orderbook(coin="BTC", size_usd=250_000)                         # $0.003
```

Each method pays the 402 challenge with your wallet and returns the JSON answer as a `dict` (with `venues_missing`, `units`, `as_of` and a `see_also` pointer). `DERIVS_ROUTES` lists all 10 routes with price and MCP tool. `client.call_with_receipt(path, params)` also returns the settlement receipt.

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price ($0.003 or $0.005); `DerivsClient(account, max_price_usd=0.003)` sets one cap for every route and refuses the $0.005 routes. A refused call signs nothing and raises `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

Bad input is a free 400 with `error.expected`. When fewer venues answer than the route needs, the answer is a 503 and nothing is charged. Both raise `DuoApiError`.

## Links

- Service and docs: https://derivs.duoleads.com (OpenAPI: https://derivs.duoleads.com/openapi.json)
- Paid MCP server with the same 10 tools: `https://derivs.duoleads.com/mcp`
- Listed on PayAPI Market (settlement-verified): https://payapi.market/api/crypto-derivatives-data-api

Data only, not investment advice, not affiliated with any exchange. The client sends a User-Agent naming this package and its version; pass `user_agent=` to change it.

MIT licensed.
