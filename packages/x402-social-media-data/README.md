# x402-social-media-data

Social media data API for AI agents: social listening and research across X (Twitter), Reddit, TikTok, Instagram, YouTube, Threads, Facebook ads, LinkedIn, Bluesky and Hacker News. Public posts, profiles, comments, video transcripts, cross-platform search and mentions in one shared schema. 26 routes, $0.01 to $0.025 per call, paid per request with [x402](https://x402.org) (USDC on Base). No API key, no signup.

This is the TypeScript client for https://social.duoleads.com. It is also part of [`duo-data-utilities`](https://www.npmjs.com/package/duo-data-utilities) (as `client.social`); this package has the social client only.

## Install

```sh
npm install x402-social-media-data viem
```

`viem` creates the wallet account that pays. Node.js 20 or later.

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "x402-social-media-data";

// Your wallet holds USDC on Base. Read the key from the environment, never a literal.
const client = createClient({ account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`) });

const bsky = await client.blueskySearch({ q: "open source", limit: 10 });  // $0.01
const hn = await client.hackernewsSearch({ q: "x402" });                   // $0.01
const tweets = await client.xSearch({ q: "nasa" });                        // $0.02
const all = await client.socialSearch({ q: "open source" });               // $0.025, several platforms at once
```

Each method sends one GET, pays the 402 challenge with your wallet and resolves to the JSON answer; paged routes return `next_cursor` for the next call. `client.callWithReceipt(path, params)` also returns the settlement receipt (transaction hash).

## Price guard

Before anything is signed, the client checks the payment requirement: Base USDC only, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`, and never above the cap. By default each route is capped at its own listed price; `createClient({ account, maxPriceUsd: 0.01 })` allows the $0.01 routes only. A refused call signs nothing and throws `PriceGuardError`. The client never retries a paid call on its own.

## Errors and charges

A bad input is answered free with a 400; not found or no match is not charged. Errors throw `DuoApiError` with `code`, `param`, `expected` and `requestId`.

## Routes

<!-- routes:social:client. -->
| Method | Route | Price | MCP tool | What it returns |
|---|---|---|---|---|
| `client.blueskySearch` | `GET /v1/bluesky/search` | $0.01 | `bluesky_search` | Bluesky post search |
| `client.blueskyPosts` | `GET /v1/bluesky/posts` | $0.01 | `bluesky_posts` | Bluesky account feed |
| `client.blueskyProfile` | `GET /v1/bluesky/profile` | $0.01 | `bluesky_profile` | Bluesky profile |
| `client.hackernewsSearch` | `GET /v1/hackernews/search` | $0.01 | `hackernews_search` | Hacker News search |
| `client.hackernewsThread` | `GET /v1/hackernews/thread` | $0.01 | `hackernews_thread` | Hacker News thread |
| `client.socialMentions` | `GET /v1/social/mentions` | $0.01 | `social_mentions` | Social mentions and sentiment (aggregate) |
| `client.xSearch` | `GET /v1/x/search` | $0.02 | `x_search` | X (Twitter) post search |
| `client.xPosts` | `GET /v1/x/posts` | $0.02 | `x_posts` | X (Twitter) user timeline |
| `client.xProfile` | `GET /v1/x/profile` | $0.02 | `x_profile` | X (Twitter) profile |
| `client.redditSearch` | `GET /v1/reddit/search` | $0.02 | `reddit_search` | Reddit post search |
| `client.redditComments` | `GET /v1/reddit/comments` | $0.02 | `reddit_comments` | Reddit post comments |
| `client.tiktokVideos` | `GET /v1/tiktok/videos` | $0.02 | `tiktok_videos` | TikTok account videos |
| `client.tiktokSearch` | `GET /v1/tiktok/search` | $0.02 | `tiktok_search` | TikTok video search |
| `client.instagramProfile` | `GET /v1/instagram/profile` | $0.02 | `instagram_profile` | Instagram profile and posts |
| `client.youtubeTranscript` | `GET /v1/youtube/transcript` | $0.02 | `youtube_transcript` | YouTube transcript |
| `client.youtubeComments` | `GET /v1/youtube/comments` | $0.02 | `youtube_comments` | YouTube video comments |
| `client.threadsPosts` | `GET /v1/threads/posts` | $0.02 | `threads_posts` | Threads account posts |
| `client.facebookAds` | `GET /v1/facebook/ads` | $0.02 | `facebook_ads` | Meta Ad Library search |
| `client.socialSearch` | `GET /v1/social/search` | $0.025 | `social_search` | Social search on X, Reddit and TikTok |
| `client.socialAudience` | `GET /v1/social/audience` | $0.02 | `social_audience` | Audience and engagement stats |
| `client.socialAccounts` | `GET /v1/social/accounts` | $0.02 | `social_accounts` | Creator and brand account search |
| `client.linkedinCompany` | `GET /v1/linkedin/company` | $0.02 | `linkedin_company` | LinkedIn company page |
| `client.socialPeople` | `GET /v1/social/people` | $0.02 | `people_search` | Profile search (TikTok, Instagram, Threads) |
| `client.tiktokFollowers` | `GET /v1/tiktok/followers` | $0.02 | `tiktok_followers` | TikTok followers list |
| `client.tiktokFollowing` | `GET /v1/tiktok/following` | $0.02 | `tiktok_following` | TikTok following list |
| `client.linkedinProfile` | `GET /v1/linkedin/profile` | $0.02 | `linkedin_profile` | LinkedIn profile |
<!-- /routes -->

`SOCIAL_ROUTES` holds this table as data (path, MCP tool, price).

## Responsible use

Answers are third parties' public data. Read the service's [terms](https://social.duoleads.com/terms) and [privacy notice](https://social.duoleads.com/privacy) before you use them. Do not use the data to profile, target or train AI on individuals. Not affiliated with or endorsed by any platform.

## MCP and plain HTTP

The same 26 tools are a paid MCP server at `https://social.duoleads.com/mcp` (Streamable HTTP; `tools/list` is free). Every route also works without this package: an unpaid request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header, and any x402 v2 client can pay it.

## Links

- Docs: https://social.duoleads.com/docs
- OpenAPI: https://social.duoleads.com/openapi.json
- Machine-readable index: https://social.duoleads.com/llms.txt
- Terms: https://social.duoleads.com/terms
- Privacy: https://social.duoleads.com/privacy

## Source

Source: [github.com/hiesem/x402-social-media-data](https://github.com/hiesem/x402-social-media-data) is a generated mirror of this package from the [duo-data-utilities](https://github.com/hiesem/duo-data-utilities) monorepo (`packages/x402-social-media-data`); issues are welcome in either repository.

## License

MIT. See [LICENSE](LICENSE).
