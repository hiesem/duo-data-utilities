# duo-data-utilities (Python)

Pay-per-call data APIs for AI agents, one typed Python client for four services. Each call is paid in USDC on Base with x402 v2. No API key, no signup.

| Client | Service | What it covers | Price per call |
|---|---|---|---|
| `DuoClient` | https://api.duoleads.com | IBAN, ISIN, VAT/tax ID, GTIN barcode and 29 more utilities | $0.05 |
| `DerivsClient` (`client.derivs`) | https://derivs.duoleads.com | Crypto derivatives data: perp funding rates, open interest, futures basis, implied volatility, liquidations, order book depth | $0.003 or $0.005 |
| `KeywordsClient` (`client.keywords`) | https://keywords.duoleads.com | SEO and keyword data: search volume, CPC, keyword difficulty, Google Trends, SERP results, backlinks (44 routes) | $0.012 to $0.25 |
| `SocialClient` (`client.social`) | https://social.duoleads.com | Social media data: public posts, profiles, comments and search on X, Reddit, TikTok, Instagram, YouTube, LinkedIn, Bluesky and Hacker News (26 routes) | $0.01 to $0.025 |

```sh
pip install duo-data-utilities
```

Python 3.10 or later. Only need one service? The same clients ship as standalone packages: [`x402-seo-keyword-data`](https://pypi.org/project/x402-seo-keyword-data/), [`x402-crypto-derivatives-data`](https://pypi.org/project/x402-crypto-derivatives-data/) and [`x402-social-media-data`](https://pypi.org/project/x402-social-media-data/).

## Quick start

```python
import os

from eth_account import Account
from duo_data_utilities import DuoClient

client = DuoClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))  # your wallet, never a literal key
print(client.iban.validate(iban="NL91 ABNA 0417 1643 00")["valid"])  # $0.05
```

`DuoClient` shares one wallet across the four services (`client.derivs`, `client.keywords`, `client.social`). Method names match the TypeScript client in snake_case.

## Crypto derivatives data

```python
rates = client.derivs.funding_rates(coin="BTC")                   # $0.003
book = client.derivs.orderbook(coin="BTC", size_usd=250_000)      # $0.003
arb = client.derivs.funding_arbitrage(min_apr=20)                 # $0.005, all coins
```

Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX. When fewer venues answer than the route needs, the answer is a 503 and nothing is charged. Data only, not investment advice.

## SEO and keyword data

```python
volume = client.keywords.search_volume(keywords=["phone", "watch"], country="us")    # $0.04 (GET)
ideas = client.keywords.keyword_ideas(keyword="seo api", limit=50)                    # $0.04 (POST, JSON body)
trend = client.keywords.trend(keyword="seo tools", timeframe="past_12_months")        # $0.045
gap = client.keywords.keyword_gap(domain="example.com", competitor="example.org")     # $0.048
```

Each route has its own HTTP method (most are POST with a JSON body); the client picks it. Parameters keep their API names (`locationCode`, `includeMonthly`). `SEO_KEYWORD_ROUTES` lists all 44 routes with HTTP method, price and MCP tool. A bad input is a free 400; an upstream failure is a 503 with "nothing was charged".

## Social media data

```python
posts = client.social.bluesky_search(q="x402", limit=10)    # $0.01
tweets = client.social.x_search(q="x402 payments")          # $0.02
everywhere = client.social.social_search(q="x402")          # $0.025
```

Every route is a GET. `SOCIAL_ROUTES` lists all 26. Answers are third parties' public data: read the service's terms and privacy notice, and do not use the data to profile, target or train AI on individuals.

## Price guard

Before anything is signed, each client refuses a payment requirement on another network than Base, in another asset than Base USDC, to another payee than `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39` (`pay_to=`), or above its cap. A refusal signs nothing and raises `PriceGuardError`. The client never retries a paid call on its own.

- Main API: `max_price_usd=0.05`.
- Derivs, keywords, social: each route is capped at its own listed price by default. One cap for all routes of a service: `DuoClient(account, derivs_max_price_usd=0.003, keywords_max_price_usd=0.04, social_max_price_usd=0.01)`, or `max_price_usd=` on `DerivsClient`, `KeywordsClient` and `SocialClient`.
- `session=` (a `requests.Session` that already pays) replaces the wallet; the guard cannot check payments made inside it.

Errors raise `DuoApiError` with `code`, `param`, `expected`, `status` and `request_id`. `call_with_receipt(path, params)` returns the answer with the settlement receipt.

The full documentation, the route tables and the MCP servers are in the repository README: https://github.com/hiesem/duo-data-utilities

The client sends a User-Agent naming the SDK and version (`duo-data-utilities-py/<version> (+https://github.com/hiesem/duo-data-utilities)`); the services store only a coarse client class, see https://api.duoleads.com/privacy. Pass `user_agent=` to change it.
