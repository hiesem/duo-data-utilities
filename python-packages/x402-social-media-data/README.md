# x402-social-media-data (Python)

Social media data API for AI agents: social listening on X (Twitter), Reddit, TikTok, Instagram, YouTube, Threads, LinkedIn, Bluesky and Hacker News, plus Facebook ads, cross-platform search and mentions. Public posts, profiles, comments, transcripts and search. 26 routes, $0.01 to $0.025 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup.

This is the Python client for https://social.duoleads.com. It is also part of [`duo-data-utilities`](https://pypi.org/project/duo-data-utilities/) (as `DuoClient(...).social`); this package has the social client only and does not depend on it. TypeScript: [`x402-social-media-data` on npm](https://www.npmjs.com/package/x402-social-media-data).

## Install

```sh
pip install x402-social-media-data
```

Python 3.10 or later. `eth-account` (installed with it) creates the wallet account that pays.

## Quick start

```python
import os

from eth_account import Account
from x402_social_media_data import SocialClient

# Your wallet holds USDC on Base. Read the key from the environment, never a literal.
client = SocialClient(Account.from_key(os.environ["PAYER_KEY"]))

posts = client.bluesky_search(q="x402", limit=10)          # $0.01
stories = client.hackernews_search(q="x402")               # $0.01
tweets = client.x_search(q="x402 payments")                # $0.02
everywhere = client.social_search(q="x402")                # $0.025, several platforms in one call
```

Every route is a GET; each method pays the 402 challenge with your wallet and returns the JSON answer as a `dict`. Method names are the route paths in snake_case (`/v1/x/search` is `x_search`). `SOCIAL_ROUTES` lists all 26 routes with price and MCP tool. `client.call_with_receipt(path, params)` also returns the settlement receipt.

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price ($0.01, $0.02 or $0.025); `SocialClient(account, max_price_usd=0.01)` allows the $0.01 routes only. A refused call signs nothing and raises `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

A bad input is a free 400; not found or no match is not charged. Both raise `DuoApiError` with `code`, `param`, `expected` and `request_id`.

## Responsible use

Answers are third parties' public data. Read the service's terms and privacy notice (https://social.duoleads.com/terms, https://social.duoleads.com/privacy); do not use the data to profile, target or train AI on individuals.

## Links

- Service and docs: https://social.duoleads.com (OpenAPI: https://social.duoleads.com/openapi.json)
- Paid MCP server with the same 26 tools: `https://social.duoleads.com/mcp`
- Listed on PayAPI Market (settlement-verified): https://payapi.market/api/social-media-data-api

Not affiliated with or endorsed by X, Reddit, TikTok, Meta, LinkedIn, YouTube, Bluesky, Hacker News or any other platform. The client sends a User-Agent naming this package and its version; pass `user_agent=` to change it.

MIT licensed.
