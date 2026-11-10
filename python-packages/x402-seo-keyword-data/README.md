# x402-seo-keyword-data (Python)

SEO and keyword data API for AI agents: Google search volume, CPC, keyword difficulty, keyword ideas, Google Trends, SERP results, backlinks, domain rankings, keyword gap, on-page audits and more. 44 routes, $0.012 to $0.25 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup, no subscription.

This is the Python client for https://keywords.duoleads.com. It is also part of [`duo-data-utilities`](https://pypi.org/project/duo-data-utilities/) (as `DuoClient(...).keywords`); this package has the keyword client only and does not depend on it. TypeScript: [`x402-seo-keyword-data` on npm](https://www.npmjs.com/package/x402-seo-keyword-data).

## Install

```sh
pip install x402-seo-keyword-data
```

Python 3.10 or later. `eth-account` (installed with it) creates the wallet account that pays.

## Quick start

```python
import os

from eth_account import Account
from x402_seo_keyword_data import KeywordsClient

# Your wallet holds USDC on Base. Read the key from the environment, never a literal.
client = KeywordsClient(Account.from_key(os.environ["PAYER_KEY"]))

volume = client.search_volume(keywords=["phone", "watch"], country="us")       # $0.04 (GET)
ideas = client.keyword_ideas(keyword="seo api", limit=50)                       # $0.04 (POST, JSON body)
trend = client.trend(keyword="seo tools", timeframe="past_12_months")           # $0.045
serp = client.serp(q="coffee maker", country="us")                              # $0.018
gap = client.keyword_gap(domain="example.com", competitor="example.org")        # $0.048
for row in volume["results"]:
    print(row["keyword"], row["volume"], row["cpc"])
```

Each method sends the route's request (most are POST with a JSON body, a few GET), pays the 402 challenge with your wallet and returns the JSON answer as a `dict`. Method names are the route paths in snake_case (`/v1/keyword-gap` is `keyword_gap`); parameters keep their API names (`locationCode`, `includeMonthly`). `SEO_KEYWORD_ROUTES` lists all 44 routes with HTTP method, price and MCP tool. `client.call_with_receipt(path, params)` also returns the settlement receipt (transaction hash).

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price; `KeywordsClient(account, max_price_usd=0.05)` sets one cap for every route. A refused call signs nothing and raises `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

A bad input is answered free with a 400; an upstream failure is a 503 with "nothing was charged". Both raise `DuoApiError` with `code`, `param`, `expected` and `request_id`.

## Links

- Service and docs: https://keywords.duoleads.com (OpenAPI: https://keywords.duoleads.com/openapi.json)
- Paid MCP server with the same 44 tools: `https://keywords.duoleads.com/mcp`
- Terms and privacy: https://keywords.duoleads.com/terms, https://keywords.duoleads.com/privacy
- Listed on PayAPI Market (settlement-verified): https://payapi.market/api/seo-and-keyword-data-api

The client sends a User-Agent naming this package and its version (`x402-seo-keyword-data-py/<version> (+https://github.com/hiesem/duo-data-utilities)`); pass `user_agent=` to change it. Not affiliated with or endorsed by Google, Amazon, Microsoft or any other platform.

MIT licensed.
