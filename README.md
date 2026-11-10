IBAN, ISIN, VAT/tax ID and GTIN barcode validation plus 29 more utilities for AI agents. Pay per call ($0.05 USDC on Base via x402), no API key, no signup.

Timezone and DST, geo distance and geohash, hashes and JWT decoding, airport, country, currency and NUTS lookups, money split, base conversion and more. Every call is one HTTP GET, paid per request.

Also crypto derivatives data for trading agents: perp funding rates, funding arbitrage, open interest, futures basis, implied volatility, liquidations and order book depth across Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX, at $0.003 or $0.005 per call ([below](#crypto-derivatives-data-perp-funding-rates-open-interest-futures-basis-implied-volatility-liquidations-order-book-depth)).

Also SEO and keyword data: Google search volume, CPC, keyword difficulty, keyword ideas, Google Trends, SERP results, backlinks, domain rankings, keyword gap, on-page audits and more, 44 routes at $0.012 to $0.25 ([below](#seo-and-keyword-data-search-volume-cpc-keyword-difficulty-google-trends-serp-backlinks)). And social media data for social listening: public posts, profiles, comments and search on X (Twitter), Reddit, TikTok, Instagram, YouTube, LinkedIn, Bluesky and Hacker News, 26 routes at $0.01 to $0.025 ([below](#social-media-data-x-twitter-reddit-tiktok-instagram-youtube-linkedin-bluesky-hacker-news)).

Only need one service? The same clients ship as small standalone packages: [`x402-seo-keyword-data`](https://www.npmjs.com/package/x402-seo-keyword-data), [`x402-crypto-derivatives-data`](https://www.npmjs.com/package/x402-crypto-derivatives-data) and [`x402-social-media-data`](https://www.npmjs.com/package/x402-social-media-data).

## Install

```sh
npm install duo-data-utilities viem
```

`viem` creates the wallet account that pays. This package also depends on it. Node.js 20 or later.

Python (all four services; or one service: `pip install x402-seo-keyword-data`, `x402-crypto-derivatives-data` or `x402-social-media-data`):

```sh
pip install duo-data-utilities
```

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "duo-data-utilities";

// Your wallet holds USDC on Base. Read the key from the environment, never a literal.
const client = createClient({ account: privateKeyToAccount(process.env.DUO_PAYER_KEY as `0x${string}`) });

const iban = await client.iban.validate({ iban: "NL91 ABNA 0417 1643 00" }); // $0.05
console.log(iban.valid, iban.country); // true NL
```

## Counterparty check

`checkCounterparty` runs three checks in one call: IBAN (`/v1/id/iban`), tax ID (`/v1/id/national`) and country (`/v1/ref/country`). It costs $0.15.

```ts
const check = await client.checkCounterparty({
  iban: "NL91 ABNA 0417 1643 00",
  country: "NL",
  taxIdType: "bsn",
  taxId: "111222333",
});
console.log(check.verdict, check.reasons); // "pass", "fail" or "review"
```

- `fail`: the IBAN or the tax ID fails its checksum, the country is not an ISO 3166-1 country, or the API rejects an input as malformed.
- `review`: the IBAN country differs from the tax ID country, or the API does not cover that country or tax ID kind.
- `pass`: every check passed.

Structure and checksum only. The check does not query a company register, a bank or a tax authority, and it does not confirm that an account exists. `UK` is read as `GB`.

## Crypto derivatives data: perp funding rates, open interest, futures basis, implied volatility, liquidations, order book depth

`client.derivs` calls https://derivs.duoleads.com: crypto derivatives data from 8 exchanges (Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit, OKX) for trading agents and bots. Perpetual futures (perp) funding rates with predicted funding, funding rate history and a funding arbitrage scanner, a perp screener, open interest (OI), futures basis and term structure, options implied volatility (IV), skew and max pain, liquidations, and order book depth with slippage. **$0.003 or $0.005 per call**, same wallet, same x402 payment, no API key.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient, createDerivsClient } from "duo-data-utilities";

const account = privateKeyToAccount(process.env.DUO_PAYER_KEY as `0x${string}`);
const client = createClient({ account });

const funding = await client.derivs.fundingRates({ coin: "BTC" }); // $0.003
for (const v of funding.venues) console.log(v.venue, v.apr_pct, v.next_funding_time);

const arb = await client.derivs.fundingArbitrage({ min_apr: 20, min_volume_usd: 1_000_000 }); // $0.005, all coins
const snap = await client.derivs.derivativesSnapshot({ coin: "ETH" }); // $0.005: funding, OI, basis, liquidations, long/short

// Or a derivs-only client:
const derivs = createDerivsClient({ account });
await derivs.openInterest({ coin: "SOL" }); // $0.003
```

```python
import os

from eth_account import Account
from duo_data_utilities import DerivsClient, DuoClient

client = DuoClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))
rates = client.derivs.funding_rates(coin="BTC")               # $0.003
book = client.derivs.orderbook(coin="BTC", size_usd=250_000)  # $0.003
derivs = DerivsClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))  # derivs only
```

- **Price guard:** `client.derivs` has its own cap. By default each route is capped at its own listed price ($0.003 or $0.005), so a challenge above it is refused. `createClient({ account, derivs: { maxPriceUsd: 0.003 } })` sets one cap for every route and refuses the $0.005 routes (Python: `derivs_max_price_usd=0.003`). The other rules are the same: Base USDC only, only to `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, nothing is signed before the check.
- **Not charged:** bad input is a free 400 with `error.expected`. When fewer venues answer than the route needs, the answer is a 503 and nothing is charged. Both throw `DuoApiError`.
- **Answers** are the JSON body itself (no `data` envelope), with `venues_missing`, `units`, `as_of` and a `see_also` pointer to the next useful route. TypeScript types: `DerivsFundingRatesData` and so on.
- **Coins:** BTC, btc, BTCUSDT, BTC-PERP, XBT, 1000PEPE and kPEPE all name a coin.
- **MCP:** the same 10 tools at `https://derivs.duoleads.com/mcp`. Snippets for Claude Code, Claude Desktop, Cursor and VS Code: [mcp/README.md](mcp/README.md#crypto-derivatives-mcp-server-perp-funding-rates-open-interest-futures-basis-implied-volatility-liquidations-order-book-depth).
- Data only, not investment advice, not affiliated with any exchange.

| TypeScript | Python | Route | Price | What it returns |
|---|---|---|---|---|
| `derivs.fundingRates` | `derivs.funding_rates` | `/v1/funding-rates` | $0.003 | Perp funding rates per exchange for one coin: rate, 8h rate, APR, next funding, predicted funding (incl. Binance and Bybit, as Hyperliquid publishes it), last 24 prints |
| `derivs.fundingHistory` | `derivs.funding_history` | `/v1/funding-history` | $0.003 | Funding rate history of one coin on one exchange, up to 30 days, with avg/min/max/% positive |
| `derivs.fundingArbitrage` | `derivs.funding_arbitrage` | `/v1/funding-arbitrage` | $0.005 | Funding arbitrage scanner for all coins: widest cross-venue spread, long and short venue, fee-adjusted net APR, breakeven days |
| `derivs.perpScreener` | `derivs.perp_screener` | `/v1/perp-screener` | $0.005 | Perp screener: every perpetual across venues, sorted by funding APR, open interest, 24h volume or 24h change |
| `derivs.openInterest` | `derivs.open_interest` | `/v1/open-interest` | $0.003 | Open interest (OI) per exchange in coins and USD, share, and 1h/4h/24h OI change |
| `derivs.basis` | `derivs.basis` | `/v1/basis` | $0.003 | Futures basis and term structure (annualised, contango/backwardation), perp premium, predicted funding |
| `derivs.options` | `derivs.options` | `/v1/options` | $0.003 | Implied volatility (ATM IV), 25-delta skew, put/call OI ratio, max pain, DVOL; options chain with greeks for one expiry |
| `derivs.liquidations` | `derivs.liquidations` | `/v1/liquidations` | $0.003 | Long and short liquidations in USD per venue over 1-24h, totals and the largest events |
| `derivs.orderbook` | `derivs.orderbook` | `/v1/orderbook` | $0.003 | Order book depth within 0.1/0.5/1/2% of mid, spread, imbalance, slippage for your order size, walls |
| `derivs.derivativesSnapshot` | `derivs.derivatives_snapshot` | `/v1/derivatives-snapshot` | $0.005 | One-call snapshot: funding, open interest, perp premium and nearest basis, 24h liquidations, long/short ratio |

Derivs docs: https://derivs.duoleads.com/docs · OpenAPI: https://derivs.duoleads.com/openapi.json · Index: https://derivs.duoleads.com/llms.txt · Terms: https://derivs.duoleads.com/terms · Privacy: https://derivs.duoleads.com/privacy

## SEO and keyword data: search volume, CPC, keyword difficulty, Google Trends, SERP, backlinks

`client.keywords` calls https://keywords.duoleads.com, 44 routes. Keyword research: Google search volume, CPC, competition, keyword difficulty and search intent (Google Ads data), keyword ideas, related keywords, variations and volume history. Google Trends. Domains and rankings: domain overview, traffic estimate, ranked keywords, competitors, keyword gap, SERP competitors, historical rank. Backlinks: summary, list, referring domains, anchors, history. Site tools: on-page audit and PageSpeed. Amazon keywords and search. Google, Bing, YouTube and Maps results, SERP history and business listings. Brand mentions and AI-answer (LLM) mentions, tech stack and WHOIS. Calls cost **$0.012 to $0.25** each and use the same wallet and the same x402 payment, with no API key.

```ts
const volume = await client.keywords.searchVolume({ keywords: ["phone", "watch"], country: "us" }); // $0.04, up to 20 keywords
const overview = await client.keywords.keywordOverview({ keywords: myList });                        // $0.04, up to 100 keywords (POST)
const ideas = await client.keywords.keywordIdeas({ keyword: "seo api", limit: 50 });                 // $0.04 (POST)
const trend = await client.keywords.trend({ keyword: "seo tools", timeframe: "past_12_months" });    // $0.045
const gap = await client.keywords.keywordGap({ domain: "example.com", competitor: "example.org" });  // $0.048
const serp = await client.keywords.serp({ q: "coffee maker", country: "us" });                       // $0.018
const links = await client.keywords.backlinks({ target: "example.com" });                            // $0.048

// Or a keywords-only client (also published alone as x402-seo-keyword-data):
const keywords = createKeywordsClient({ account });
await keywords.relatedQueries({ keyword: "seo api", country: "us" }); // $0.03
```

- **Price guard:** `client.keywords` has its own cap. By default each of the 44 routes is capped at its own listed price, so a challenge above it is refused. `createClient({ account, keywords: { maxPriceUsd: 0.04 } })` sets one cap for every route (that one refuses trend and every route above $0.04). The other rules are the same: Base USDC only, only to `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and nothing is signed before the check.
- **Methods:** each route has its own HTTP method (most are POST with a JSON body); the client picks it. `SEO_KEYWORD_ROUTES` lists all 44 with method, price and MCP tool.
- **Errors:** a bad input is a free 400. An upstream failure is a 503 with "nothing was charged". Both throw `DuoApiError`.
- **MCP:** the same 44 tools are at `https://keywords.duoleads.com/mcp`.

<!-- routes:keywords:keywords. -->
| Method | Route | Price | MCP tool | What it returns |
|---|---|---|---|---|
| `keywords.keywordOverview` | `POST /v1/keyword-overview` | $0.04 | `keyword_overview` | Keyword overview (up to 100 keywords) |
| `keywords.searchVolume` | `GET /v1/search-volume` | $0.04 | `keyword_search_volume` | Search volume (GET, up to 20 keywords) |
| `keywords.keywordIdeas` | `POST /v1/keyword-ideas` | $0.04 | `keyword_ideas` | Keyword ideas (up to 100 per seed) |
| `keywords.trend` | `GET /v1/trend` | $0.045 | `google_trends` | Google Trends interest over time |
| `keywords.relatedQueries` | `GET /v1/related-queries` | $0.03 | `google_trends_related_queries` | Google Trends related queries |
| `keywords.interestByRegion` | `GET /v1/interest-by-region` | $0.03 | `google_trends_by_region` | Google Trends interest by region |
| `keywords.relatedKeywords` | `POST /v1/related-keywords` | $0.04 | `related_keywords` | Related keywords (up to 100, depth 0-4) |
| `keywords.keywordVariations` | `POST /v1/keyword-variations` | $0.04 | `keyword_variations` | Keyword variations containing a phrase (up to 100) |
| `keywords.keywordDifficulty` | `POST /v1/keyword-difficulty` | $0.04 | `keyword_difficulty` | Keyword difficulty (up to 100 keywords) |
| `keywords.searchIntent` | `POST /v1/search-intent` | $0.04 | `search_intent` | Search intent (up to 100 keywords) |
| `keywords.keywordVolumeHistory` | `POST /v1/keyword-volume-history` | $0.048 | `keyword_volume_history` | Monthly search volume history (up to 20 keywords) |
| `keywords.keywordSuggestions` | `POST /v1/keyword-suggestions` | $0.04 | `keywords_for_site` | Keywords for a site or page (up to 100) |
| `keywords.trends` | `POST /v1/trends` | $0.045 | `google_trends_compare` | Google Trends comparison (up to 5 keywords) |
| `keywords.domainOverview` | `POST /v1/domain-overview` | $0.04 | `domain_overview` | Domain overview (organic and paid visibility) |
| `keywords.trafficEstimate` | `POST /v1/traffic-estimate` | $0.04 | `traffic_estimate` | Traffic estimate (up to 100 domains) |
| `keywords.rankedKeywords` | `POST /v1/ranked-keywords` | $0.048 | `ranked_keywords` | Ranked keywords of a domain (up to 100) |
| `keywords.competitors` | `POST /v1/competitors` | $0.048 | `competitor_domains` | Competitor domains (up to 100) |
| `keywords.keywordGap` | `POST /v1/keyword-gap` | $0.048 | `keyword_gap` | Keyword gap: competitor-only keywords (up to 100) |
| `keywords.serpCompetitors` | `POST /v1/serp-competitors` | $0.048 | `serp_competitors` | Domains ranking for a keyword set (up to 100) |
| `keywords.relevantPages` | `POST /v1/relevant-pages` | $0.048 | `relevant_pages` | Top pages of a domain (up to 100) |
| `keywords.historicalRank` | `POST /v1/historical-rank` | $0.25 | `historical_rank` | Monthly rank history of a domain (24 months) |
| `keywords.pageIntersection` | `POST /v1/page-intersection` | $0.048 | `page_intersection` | Keywords shared by pages (up to 20 pages) |
| `keywords.backlinks` | `POST /v1/backlinks` | $0.048 | `backlinks_summary` | Backlink profile summary |
| `keywords.backlinksList` | `POST /v1/backlinks-list` | $0.048 | `backlinks_list` | Backlinks list (up to 100) |
| `keywords.referringDomains` | `POST /v1/referring-domains` | $0.048 | `referring_domains` | Referring domains (up to 100) |
| `keywords.backlinkAnchors` | `POST /v1/backlink-anchors` | $0.048 | `backlink_anchors` | Backlink anchor texts (up to 100) |
| `keywords.backlinksHistory` | `POST /v1/backlinks-history` | $0.048 | `backlinks_history` | Backlink profile history (up to 24 months) |
| `keywords.onPage` | `POST /v1/on-page` | $0.012 | `on_page_audit` | On-page SEO audit of a URL |
| `keywords.pagespeed` | `POST /v1/pagespeed` | $0.018 | `pagespeed` | Page speed (Lighthouse Core Web Vitals) |
| `keywords.amazonKeywords` | `POST /v1/amazon-keywords` | $0.04 | `amazon_keywords` | Amazon keyword ideas and volume |
| `keywords.amazonSearch` | `POST /v1/amazon-search` | $0.012 | `amazon_search` | Amazon search results (products) |
| `keywords.serp` | `GET /v1/serp` | $0.018 | `google_search` | Google search results (10, 20 or 50) |
| `keywords.mapsSearch` | `GET /v1/maps-search` | $0.018 | `google_maps_search` | Google Maps places (up to 100) |
| `keywords.serpHistory` | `POST /v1/serp-history` | $0.018 | `serp_history` | Google results-page history (one past snapshot) |
| `keywords.businessListings` | `POST /v1/business-listings` | $0.08 | `business_listings` | Business listings by name or category (up to 50) |
| `keywords.autocomplete` | `GET /v1/autocomplete` | $0.012 | `google_autocomplete` | Google autocomplete suggestions |
| `keywords.bingSerp` | `GET /v1/bing-serp` | $0.018 | `bing_search` | Bing search results (10, 20 or 50) |
| `keywords.youtubeSearch` | `GET /v1/youtube-search` | $0.012 | `youtube_search` | YouTube search results (20 or 40) |
| `keywords.googleAdsKeywords` | `POST /v1/google-ads-keywords` | $0.16 | `google_ads_keywords` | Google Ads keyword ideas (up to 100) |
| `keywords.clickstreamSearchVolume` | `POST /v1/clickstream-search-volume` | $0.04 | `clickstream_search_volume` | Clickstream search volume (up to 100 keywords) |
| `keywords.brandMentions` | `POST /v1/brand-mentions` | $0.048 | `brand_mentions` | Brand mentions on the web (up to 100) |
| `keywords.techStack` | `POST /v1/tech-stack` | $0.024 | `tech_stack` | Website technology stack |
| `keywords.whois` | `POST /v1/whois` | $0.21 | `whois_overview` | WHOIS overview of a domain |
| `keywords.llmMentions` | `POST /v1/llm-mentions` | $0.21 | `llm_mentions` | AI answers mentioning a keyword (up to 20) |
<!-- /routes -->

Python: the same 44 routes, in snake_case, on `DuoClient(account).keywords` or `KeywordsClient(account)` (also published alone on PyPI as `x402-seo-keyword-data`). Parameters keep their API names:

```python
volume = client.keywords.search_volume(keywords=["phone", "watch"], country="us")  # $0.04 (GET)
gap = client.keywords.keyword_gap(domain="example.com", competitor="example.org")   # $0.048 (POST, JSON body)
```

Keyword docs: https://keywords.duoleads.com/docs · OpenAPI: https://keywords.duoleads.com/openapi.json · Index: https://keywords.duoleads.com/llms.txt · Terms: https://keywords.duoleads.com/terms · Privacy: https://keywords.duoleads.com/privacy

## Social media data: X (Twitter), Reddit, TikTok, Instagram, YouTube, LinkedIn, Bluesky, Hacker News

`client.social` calls https://social.duoleads.com, 26 routes for social listening and research: public posts, profiles, comments and search on X (Twitter), Reddit, TikTok, Instagram, YouTube (also transcripts), Threads, Facebook ads, LinkedIn, Bluesky and Hacker News, cross-platform search and mentions, in one shared answer schema. Calls cost **$0.01 to $0.025** each, same wallet, same x402 payment, no API key.

```ts
const posts = await client.social.blueskySearch({ q: "open source", limit: 10 }); // $0.01
const tweets = await client.social.xSearch({ q: "nasa" });                        // $0.02
const all = await client.social.socialSearch({ q: "open source" });              // $0.025, several platforms at once

// Or a social-only client (also published alone as x402-social-media-data):
const social = createSocialClient({ account });
await social.hackernewsSearch({ q: "x402" }); // $0.01
```

- **Price guard:** by default each route is capped at its own listed price; `maxPriceUsd` sets one cap for every route.
- **Errors:** a bad input is a free 400; not found or no match is not charged. Both throw `DuoApiError`.
- **Responsible use:** answers are third parties' public data. Read the service's terms and privacy notice; do not use the data to profile, target or train AI on individuals.
- **MCP:** the same 26 tools are at `https://social.duoleads.com/mcp`.

<!-- routes:social:social. -->
| Method | Route | Price | MCP tool | What it returns |
|---|---|---|---|---|
| `social.blueskySearch` | `GET /v1/bluesky/search` | $0.01 | `bluesky_search` | Bluesky post search |
| `social.blueskyPosts` | `GET /v1/bluesky/posts` | $0.01 | `bluesky_posts` | Bluesky account feed |
| `social.blueskyProfile` | `GET /v1/bluesky/profile` | $0.01 | `bluesky_profile` | Bluesky profile |
| `social.hackernewsSearch` | `GET /v1/hackernews/search` | $0.01 | `hackernews_search` | Hacker News search |
| `social.hackernewsThread` | `GET /v1/hackernews/thread` | $0.01 | `hackernews_thread` | Hacker News thread |
| `social.socialMentions` | `GET /v1/social/mentions` | $0.01 | `social_mentions` | Social mentions and sentiment (aggregate) |
| `social.xSearch` | `GET /v1/x/search` | $0.02 | `x_search` | X (Twitter) post search |
| `social.xPosts` | `GET /v1/x/posts` | $0.02 | `x_posts` | X (Twitter) user timeline |
| `social.xProfile` | `GET /v1/x/profile` | $0.02 | `x_profile` | X (Twitter) profile |
| `social.redditSearch` | `GET /v1/reddit/search` | $0.02 | `reddit_search` | Reddit post search |
| `social.redditComments` | `GET /v1/reddit/comments` | $0.02 | `reddit_comments` | Reddit post comments |
| `social.tiktokVideos` | `GET /v1/tiktok/videos` | $0.02 | `tiktok_videos` | TikTok account videos |
| `social.tiktokSearch` | `GET /v1/tiktok/search` | $0.02 | `tiktok_search` | TikTok video search |
| `social.instagramProfile` | `GET /v1/instagram/profile` | $0.02 | `instagram_profile` | Instagram profile and posts |
| `social.youtubeTranscript` | `GET /v1/youtube/transcript` | $0.02 | `youtube_transcript` | YouTube transcript |
| `social.youtubeComments` | `GET /v1/youtube/comments` | $0.02 | `youtube_comments` | YouTube video comments |
| `social.threadsPosts` | `GET /v1/threads/posts` | $0.02 | `threads_posts` | Threads account posts |
| `social.facebookAds` | `GET /v1/facebook/ads` | $0.02 | `facebook_ads` | Meta Ad Library search |
| `social.socialSearch` | `GET /v1/social/search` | $0.025 | `social_search` | Social search on X, Reddit and TikTok |
| `social.socialAudience` | `GET /v1/social/audience` | $0.02 | `social_audience` | Audience and engagement stats |
| `social.socialAccounts` | `GET /v1/social/accounts` | $0.02 | `social_accounts` | Creator and brand account search |
| `social.linkedinCompany` | `GET /v1/linkedin/company` | $0.02 | `linkedin_company` | LinkedIn company page |
| `social.socialPeople` | `GET /v1/social/people` | $0.02 | `people_search` | Profile search (TikTok, Instagram, Threads) |
| `social.tiktokFollowers` | `GET /v1/tiktok/followers` | $0.02 | `tiktok_followers` | TikTok followers list |
| `social.tiktokFollowing` | `GET /v1/tiktok/following` | $0.02 | `tiktok_following` | TikTok following list |
| `social.linkedinProfile` | `GET /v1/linkedin/profile` | $0.02 | `linkedin_profile` | LinkedIn profile |
<!-- /routes -->

Python: the same 26 routes, in snake_case, on `DuoClient(account).social` or `SocialClient(account)` (also published alone on PyPI as `x402-social-media-data`):

```python
posts = client.social.bluesky_search(q="open source", limit=10)  # $0.01
tweets = client.social.x_search(q="nasa")                        # $0.02
```

Social docs: https://social.duoleads.com/docs · OpenAPI: https://social.duoleads.com/openapi.json · Index: https://social.duoleads.com/llms.txt · Terms: https://social.duoleads.com/terms · Privacy: https://social.duoleads.com/privacy

## Methods

Every method costs $0.05 per call. Each method's JSDoc gives the route and the parameters. `client.call(path, params)` calls any route, and `client.callWithReceipt(path, params)` also returns the settlement receipt.

| Method | Route | What it does |
|---|---|---|
| `iban.validate` | `/v1/id/iban` | IBAN validator: length, mod-97 check digits, bank/branch/account breakdown (89 countries) |
| `iban.generate` | `/v1/id/iban-build` | IBAN generator: build an IBAN from country and BBAN or bank/branch/account, computing check digits |
| `taxId.validate` | `/v1/id/national` | VAT, tax ID and national ID validator: 23 countries, checksum only (VAT formats BE, DE, FR, IT, PL, AT, CH, IE) |
| `isin.validate` | `/v1/id/security` | ISIN validator plus CUSIP, SEDOL and FIGI check-digit validation; builds an ISIN from an NSIN |
| `barcode.validate` | `/v1/id/gs1` | GTIN barcode validator: EAN-13, UPC-A (GTIN-12), GTIN-8/14, GLN and SSCC check digits |
| `timezone.convert` | `/v1/time/zone` | Timezone converter: instant to local time in an IANA time zone and back, with UTC offset and DST state |
| `timezone.dstTransitions` | `/v1/time/dst` | DST transitions: next daylight-saving time changes for an IANA time zone |
| `businessDays.calculate` | `/v1/time/business-days` | Business days calculator: add or count working days with your weekend mask and holiday list |
| `rrule.expand` | `/v1/time/rrule` | RRULE expander: RFC 5545 recurrence rule to concrete occurrence dates |
| `calendar.convert` | `/v1/time/calendar` | Calendar converter: Gregorian to Hijri, Hebrew, Japanese era, Persian and more, plus Easter date |
| `text.similarity` | `/v1/text/similarity` | String similarity: Levenshtein, Jaro-Winkler distance and Soundex/Metaphone phonetic keys |
| `text.slug` | `/v1/text/slug` | Slug generator: Unicode-aware URL slug with transliteration |
| `text.transliterate` | `/v1/text/transliterate` | Cyrillic transliteration to Latin (ISO 9:1995, BGN/PCGN Russian) |
| `text.unicode` | `/v1/text/unicode` | Unicode normalization (NFC/NFKC), script detection and homoglyph/confusable check |
| `hash.generate` | `/v1/code/hash` | Hash generator: SHA-256, SHA-512, SHA-3, Keccak-256, BLAKE2 and HMAC digests |
| `punycode.convert` | `/v1/code/idn` | Punycode converter: IDN domain to ASCII and back, with IDNA2008 label validation |
| `jwt.decode` | `/v1/code/jwt` | JWT decoder: header, claims and expiry state (no signature verification) |
| `semver.compare` | `/v1/code/semver` | Semver parser: parse and compare versions, check range satisfaction |
| `url.parse` | `/v1/code/url` | URL parser: parse, canonicalize and extract the registrable domain (eTLD+1) |
| `geohash.encodeDecode` | `/v1/geo/geohash` | Geohash encoder and decoder with neighbour cells |
| `plusCode.encodeDecode` | `/v1/geo/pluscode` | Plus code (Open Location Code) encoder and decoder |
| `polygon.check` | `/v1/geo/polygon` | Point in polygon check, plus bounding box, centroid and area for GeoJSON |
| `distance.calculate` | `/v1/geo/distance` | Distance calculator: geodesic distance, bearing and destination point on WGS-84 |
| `cryptoAddress.validate` | `/v1/chain/address` | Crypto address validator: detect the blockchain and verify the checksum (EVM, Bitcoin, Solana and more) |
| `solidity.selector` | `/v1/chain/selector` | Solidity function selector: Keccak-256, 4-byte selector and event topic from a signature |
| `airport.lookup` | `/v1/ref/airport` | Airport lookup by IATA or ICAO code: name, coordinates, elevation, time zone; nearest airports |
| `country.lookup` | `/v1/ref/country` | Country lookup: ISO 3166 codes, currency, TLD, UN region and ISO 3166-2 subdivisions |
| `currency.lookup` | `/v1/ref/currency` | Currency lookup: ISO 4217 codes, names, minor units and cash rounding |
| `nuts.lookup` | `/v1/ref/nuts` | NUTS region lookup: EU statistical region codes, names and hierarchy |
| `money.split` | `/v1/num/allocate` | Money split: allocate an amount into shares with no rounding loss |
| `base.convert` | `/v1/num/radix` | Base converter: integers between number bases 2 to 36 (hex, binary, octal) |
| `statistics.calculate` | `/v1/num/stats` | Statistics calculator: mean, median, standard deviation, quartiles and percentiles |
| `numberWords.convert` | `/v1/num/words` | Number to words in 12 languages, with ordinal and currency forms |

## MCP

The MCP server is at `https://api.duoleads.com/mcp` (Streamable HTTP). `tools/list` is free. Each `tools/call` costs $0.05 and needs an x402-capable client or wallet bridge. The derivatives tools are a second server at `https://derivs.duoleads.com/mcp` ($0.003 or $0.005 per call), the keyword tools a third at `https://keywords.duoleads.com/mcp` ($0.012 to $0.25) and the social tools a fourth at `https://social.duoleads.com/mcp` ($0.01 to $0.025). See [mcp/README.md](mcp/README.md) for Claude Code, Claude Desktop, Cursor, VS Code and AgentCash.

## Python

Python 3.10 or later. The client is typed (`py.typed`) and uses `requests` with x402's EVM signer. Routes and method names match the TypeScript client, in snake_case. The Python client covers all four services: `client.derivs`, `client.keywords` and `client.social` share the wallet of `DuoClient`, and `DerivsClient`, `KeywordsClient` and `SocialClient` work on their own. Each per-service client is also published alone on PyPI (`x402-crypto-derivatives-data`, `x402-seo-keyword-data`, `x402-social-media-data`), standalone like the npm packages.

```python
import os

from eth_account import Account
from duo_data_utilities import DuoClient

client = DuoClient(Account.from_key(os.environ["DUO_PAYER_KEY"]))  # your wallet, never a literal key
print(client.iban.validate(iban="NL91 ABNA 0417 1643 00")["valid"])

check = client.check_counterparty(iban="NL91 ABNA 0417 1643 00", country="NL", tax_id_type="bsn", tax_id="111222333")
print(check.verdict, check.reasons)
```

`DuoClient(account, *, max_price_usd=0.05, timeout=None, pay_to=<service address>)` applies the same price guard. Pass `session=` with a `requests.Session` that already pays to skip the guard. `from_` is the Python name for the `from` query parameter.

## Pricing and the price guard

- Every main API route costs $0.05 per call, paid in USDC on Base (`eip155:8453`) with x402 v2. Derivs routes cost $0.003 or $0.005, keyword routes $0.012 to $0.25 and social routes $0.01 to $0.025, each capped by default at its own listed price. See each section.
- `maxPriceUsd` defaults to `0.05`. Before anything is signed, the client refuses a payment requirement that asks for more than that, a network other than Base, an asset other than Base USDC, or another payee. A refused call makes no payment and throws `PriceGuardError`.
- The client only signs payments to the service's public address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39` (`payTo` option; `pay_to` in Python). Set it if you point `baseUrl` at another deployment.
- The client never retries a paid call on its own.
- Plain `http://` is refused except for loopback addresses (`localhost`, `127.0.0.1`, `[::1]`).
- With `fetch` instead of `account`, you pass a fetch that already pays. The price guard cannot check payments made inside it, so use `account` to keep the guard.

## Examples

Runnable agents in [`examples/`](examples/). Each folder has a README with setup, environment variables and cost.

| Example | Language | What it does |
|---|---|---|
| [supplier-onboarding-agent](examples/supplier-onboarding-agent/) | TypeScript | Supplier / vendor onboarding check: builds and validates IBANs, checks VAT numbers, compares the account holder name. Approve, review or reject per supplier. |
| [kyb-payout-agent-python](examples/kyb-payout-agent-python/) | Python | KYB payout validation agent with Claude tool use: IBAN, VAT / tax ID, country and name checks, with a spend cap. |
| [mcp-paid-client](examples/mcp-paid-client/) | TypeScript | MCP client for `https://api.duoleads.com/mcp` that pays each `tools/call` with x402, plus an MCP host config. |
| [funding-arbitrage-watcher](examples/funding-arbitrage-watcher/) | TypeScript | Funding rate arbitrage watcher: scans perp funding spreads across 8 exchanges every few minutes and alerts on new fee-adjusted opportunities. $0.005 per scan; the default run costs $0.06. |
| [derivs-snapshot-loop-python](examples/derivs-snapshot-loop-python/) | Python | Per-coin derivatives snapshot loop: funding, open interest, basis, liquidations and long/short for each coin; flags crowded positioning. $0.005 per coin per round; the default run costs $0.06. |
| [keyword-research-agent](examples/keyword-research-agent/) | TypeScript | SEO keyword research agent: keyword ideas with search volume, CPC and difficulty, ranked by opportunity, plus a Google Trends check on the best pick. The default run (1 seed) costs $0.085. |
| [node-basic.ts](examples/node-basic.ts) | TypeScript | IBAN, time zone, counterparty check and a settlement receipt in one script. |
| [vercel-ai-sdk-tool.ts](examples/vercel-ai-sdk-tool.ts) | TypeScript | IBAN and counterparty checks as Vercel AI SDK tools. |
| [langchain_tool.py](examples/langchain_tool.py) | Python | IBAN and counterparty checks as LangChain tools. |
| [claude-mcp.md](examples/claude-mcp.md) | | Adding the MCP server to Claude Code. |

Main API calls cost $0.05, derivs calls $0.003 or $0.005, keyword calls $0.012 to $0.25 (the examples use the $0.03 to $0.045 keyword-research calls) and social calls $0.01 to $0.025, in USDC on Base, paid by the wallet you configure. The examples' tests run offline with mocked responses; nothing in CI pays.

## User-Agent and privacy

The SDK sends a User-Agent naming the SDK and version; the API stores only a coarse client class, see https://api.duoleads.com/privacy

- TypeScript: `duo-data-utilities-js/<version> (+https://github.com/hiesem/duo-data-utilities)`. Override it with `createClient({ userAgent })`, or append your own product: ``userAgent: `${SDK_USER_AGENT} my-agent/1.0` ``.
- Python: `duo-data-utilities-py/<version> (+https://github.com/hiesem/duo-data-utilities)`. Override it with `DuoClient(..., user_agent=...)`, or append to `duo_data_utilities.USER_AGENT`.
- In browsers a page cannot set User-Agent, so the client sends none there, and it adds no other header in its place (one would make the browser send a CORS preflight, which the API does not accept). The browser's own User-Agent is sent instead.

## What this is not

- Not a registry lookup. IBAN, tax ID and VAT checks are structure and checksum only.
- Not financial, legal or tax advice. Each response carries a disclaimer.
- Derivatives data is data only: not investment advice, not a benchmark, not affiliated with any exchange.
- Keyword and social data come from third-party providers and public sources; not affiliated with or endorsed by Google, X, Reddit, TikTok, Meta, LinkedIn or any other platform.

## Links

- API docs: https://api.duoleads.com/docs
- OpenAPI: https://api.duoleads.com/openapi.json
- Machine-readable index: https://api.duoleads.com/llms.txt
- Terms: https://api.duoleads.com/terms
- Privacy: https://api.duoleads.com/privacy
- Listed on PayAPI Market (settlement-verified): [Duo Data Utilities](https://payapi.market/api/duo-data-utilities), [SEO and Keyword Data API](https://payapi.market/api/seo-and-keyword-data-api), [Crypto Derivatives Data API](https://payapi.market/api/crypto-derivatives-data-api), [Social Media Data API](https://payapi.market/api/social-media-data-api)

The HTTP routes also work without this SDK. An unpaid `GET` returns `402 Payment Required` with a `PAYMENT-REQUIRED` header, and any x402 v2 client can pay that challenge.

## Development

```sh
npm install
npm run generate        # rebuild src/*generated.ts and the README route tables from spec/ (npm test checks they are current)
node scripts/refresh-specs.mjs   # re-fetch the services' published OpenAPI into spec/ (free), then review the diff
python3 python/scripts/generate.py   # the same for the Python package
npm run typecheck
npm test
npm run build
```

`spec/` holds the snapshots the code is generated from. See `spec/README.md`. `packages/` holds the three per-service packages (`x402-seo-keyword-data`, `x402-crypto-derivatives-data`, `x402-social-media-data`); each bundles the shared client code from `src/`, so none depends on this package.

## License

MIT. See [LICENSE](LICENSE).
