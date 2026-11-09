# x402-seo-keyword-data

SEO and keyword data API for AI agents: Google search volume, CPC, keyword difficulty, keyword ideas, Google Trends, SERP results, backlinks, domain rankings, keyword gap, on-page audits and more. 44 routes, $0.012 to $0.25 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup, no subscription.

This is the TypeScript client for https://keywords.duoleads.com. It is also part of [`duo-data-utilities`](https://www.npmjs.com/package/duo-data-utilities) (as `client.keywords`); this package has the keyword client only.

## Install

```sh
npm install x402-seo-keyword-data viem
```

`viem` creates the wallet account that pays. Node.js 20 or later.

Python: `pip install x402-seo-keyword-data` (the same client in snake_case; source in [`python/`](python/)).

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "x402-seo-keyword-data";

// Your wallet holds USDC on Base. Read the key from the environment, never a literal.
const client = createClient({ account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`) });

const volume = await client.searchVolume({ keywords: ["phone", "watch"], country: "us" });  // $0.04
const ideas = await client.keywordIdeas({ keyword: "seo api", limit: 50 });                 // $0.04
const trend = await client.trend({ keyword: "seo tools", timeframe: "past_12_months" });    // $0.045
const serp = await client.serp({ q: "coffee maker", country: "us" });                       // $0.018
const gap = await client.keywordGap({ domain: "example.com", competitor: "example.org" });  // $0.048
const links = await client.backlinks({ target: "example.com" });                            // $0.048
```

Each method sends the route's request (most are POST with a JSON body, a few GET), pays the 402 challenge with your wallet and resolves to the JSON answer. `client.callWithReceipt(path, params)` also returns the settlement receipt (transaction hash).

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price; `createClient({ account, maxPriceUsd: 0.05 })` sets one cap for every route. A refused call signs nothing and throws `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

A bad input is answered free with a 400; an upstream failure is a 503 with "nothing was charged". Both throw `DuoApiError` with `code`, `param`, `expected` and `requestId`.

## Routes

<!-- routes:keywords:client. -->
| Method | Route | Price | MCP tool | What it returns |
|---|---|---|---|---|
| `client.keywordOverview` | `POST /v1/keyword-overview` | $0.04 | `keyword_overview` | Keyword overview (up to 100 keywords) |
| `client.searchVolume` | `GET /v1/search-volume` | $0.04 | `keyword_search_volume` | Search volume (GET, up to 20 keywords) |
| `client.keywordIdeas` | `POST /v1/keyword-ideas` | $0.04 | `keyword_ideas` | Keyword ideas (up to 100 per seed) |
| `client.trend` | `GET /v1/trend` | $0.045 | `google_trends` | Google Trends interest over time |
| `client.relatedQueries` | `GET /v1/related-queries` | $0.03 | `google_trends_related_queries` | Google Trends related queries |
| `client.interestByRegion` | `GET /v1/interest-by-region` | $0.03 | `google_trends_by_region` | Google Trends interest by region |
| `client.relatedKeywords` | `POST /v1/related-keywords` | $0.04 | `related_keywords` | Related keywords (up to 100, depth 0-4) |
| `client.keywordVariations` | `POST /v1/keyword-variations` | $0.04 | `keyword_variations` | Keyword variations containing a phrase (up to 100) |
| `client.keywordDifficulty` | `POST /v1/keyword-difficulty` | $0.04 | `keyword_difficulty` | Keyword difficulty (up to 100 keywords) |
| `client.searchIntent` | `POST /v1/search-intent` | $0.04 | `search_intent` | Search intent (up to 100 keywords) |
| `client.keywordVolumeHistory` | `POST /v1/keyword-volume-history` | $0.048 | `keyword_volume_history` | Monthly search volume history (up to 20 keywords) |
| `client.keywordSuggestions` | `POST /v1/keyword-suggestions` | $0.04 | `keywords_for_site` | Keywords for a site or page (up to 100) |
| `client.trends` | `POST /v1/trends` | $0.045 | `google_trends_compare` | Google Trends comparison (up to 5 keywords) |
| `client.domainOverview` | `POST /v1/domain-overview` | $0.04 | `domain_overview` | Domain overview (organic and paid visibility) |
| `client.trafficEstimate` | `POST /v1/traffic-estimate` | $0.04 | `traffic_estimate` | Traffic estimate (up to 100 domains) |
| `client.rankedKeywords` | `POST /v1/ranked-keywords` | $0.048 | `ranked_keywords` | Ranked keywords of a domain (up to 100) |
| `client.competitors` | `POST /v1/competitors` | $0.048 | `competitor_domains` | Competitor domains (up to 100) |
| `client.keywordGap` | `POST /v1/keyword-gap` | $0.048 | `keyword_gap` | Keyword gap: competitor-only keywords (up to 100) |
| `client.serpCompetitors` | `POST /v1/serp-competitors` | $0.048 | `serp_competitors` | Domains ranking for a keyword set (up to 100) |
| `client.relevantPages` | `POST /v1/relevant-pages` | $0.048 | `relevant_pages` | Top pages of a domain (up to 100) |
| `client.historicalRank` | `POST /v1/historical-rank` | $0.25 | `historical_rank` | Monthly rank history of a domain (24 months) |
| `client.pageIntersection` | `POST /v1/page-intersection` | $0.048 | `page_intersection` | Keywords shared by pages (up to 20 pages) |
| `client.backlinks` | `POST /v1/backlinks` | $0.048 | `backlinks_summary` | Backlink profile summary |
| `client.backlinksList` | `POST /v1/backlinks-list` | $0.048 | `backlinks_list` | Backlinks list (up to 100) |
| `client.referringDomains` | `POST /v1/referring-domains` | $0.048 | `referring_domains` | Referring domains (up to 100) |
| `client.backlinkAnchors` | `POST /v1/backlink-anchors` | $0.048 | `backlink_anchors` | Backlink anchor texts (up to 100) |
| `client.backlinksHistory` | `POST /v1/backlinks-history` | $0.048 | `backlinks_history` | Backlink profile history (up to 24 months) |
| `client.onPage` | `POST /v1/on-page` | $0.012 | `on_page_audit` | On-page SEO audit of a URL |
| `client.pagespeed` | `POST /v1/pagespeed` | $0.018 | `pagespeed` | Page speed (Lighthouse Core Web Vitals) |
| `client.amazonKeywords` | `POST /v1/amazon-keywords` | $0.04 | `amazon_keywords` | Amazon keyword ideas and volume |
| `client.amazonSearch` | `POST /v1/amazon-search` | $0.012 | `amazon_search` | Amazon search results (products) |
| `client.serp` | `GET /v1/serp` | $0.018 | `google_search` | Google search results (10, 20 or 50) |
| `client.mapsSearch` | `GET /v1/maps-search` | $0.018 | `google_maps_search` | Google Maps places (up to 100) |
| `client.serpHistory` | `POST /v1/serp-history` | $0.018 | `serp_history` | Google results-page history (one past snapshot) |
| `client.businessListings` | `POST /v1/business-listings` | $0.08 | `business_listings` | Business listings by name or category (up to 50) |
| `client.autocomplete` | `GET /v1/autocomplete` | $0.012 | `google_autocomplete` | Google autocomplete suggestions |
| `client.bingSerp` | `GET /v1/bing-serp` | $0.018 | `bing_search` | Bing search results (10, 20 or 50) |
| `client.youtubeSearch` | `GET /v1/youtube-search` | $0.012 | `youtube_search` | YouTube search results (20 or 40) |
| `client.googleAdsKeywords` | `POST /v1/google-ads-keywords` | $0.16 | `google_ads_keywords` | Google Ads keyword ideas (up to 100) |
| `client.clickstreamSearchVolume` | `POST /v1/clickstream-search-volume` | $0.04 | `clickstream_search_volume` | Clickstream search volume (up to 100 keywords) |
| `client.brandMentions` | `POST /v1/brand-mentions` | $0.048 | `brand_mentions` | Brand mentions on the web (up to 100) |
| `client.techStack` | `POST /v1/tech-stack` | $0.024 | `tech_stack` | Website technology stack |
| `client.whois` | `POST /v1/whois` | $0.21 | `whois_overview` | WHOIS overview of a domain |
| `client.llmMentions` | `POST /v1/llm-mentions` | $0.21 | `llm_mentions` | AI answers mentioning a keyword (up to 20) |
<!-- /routes -->

`SEO_KEYWORD_ROUTES` holds this table as data (path, HTTP method, MCP tool, price).

## MCP and plain HTTP

The same 44 tools are a paid MCP server at `https://keywords.duoleads.com/mcp` (Streamable HTTP; `tools/list` is free). Every route also works without this package: an unpaid request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header, and any x402 v2 client can pay it.

## Links

- Docs: https://keywords.duoleads.com/docs
- OpenAPI: https://keywords.duoleads.com/openapi.json
- Machine-readable index: https://keywords.duoleads.com/llms.txt
- Terms: https://keywords.duoleads.com/terms
- Privacy: https://keywords.duoleads.com/privacy

Data only: search volumes, CPC and rankings are estimates from third-party providers and public sources; not affiliated with or endorsed by Google, Bing, YouTube or Amazon.

## Source

Source: [github.com/hiesem/x402-seo-keyword-data](https://github.com/hiesem/x402-seo-keyword-data) is a generated mirror of this package from the [duo-data-utilities](https://github.com/hiesem/duo-data-utilities) monorepo (`packages/x402-seo-keyword-data`); issues are welcome in either repository.

## License

MIT. See [LICENSE](LICENSE).
