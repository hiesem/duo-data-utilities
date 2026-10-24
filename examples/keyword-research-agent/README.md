# Keyword research agent: keyword ideas, search volume, CPC, difficulty and Google Trends, paid per call with x402 (TypeScript)

Give it one or more seed keywords. For each seed it fetches related keyword ideas with Google monthly search volume, CPC, competition, keyword difficulty and search intent ([`/v1/keyword-ideas`](https://keywords.duoleads.com/docs)). It ranks them by opportunity (volume relative to difficulty) and checks Google Trends ([`/v1/trend`](https://keywords.duoleads.com/docs)) for the best picks, to show whether demand is rising or falling.

## Cost

Paid in USDC on Base (x402 v2) from your wallet. No API key and no signup.

| Call | Price |
|---|---|
| keyword ideas, per seed (up to 100 ideas) | $0.04 |
| Google Trends, per checked pick | $0.045 |
| **default run** (1 seed, `--trends 1`) | **$0.085** |

Before it starts, the script prints the plan and what it costs. It refuses to run when the plan costs more than `DUO_MAX_SPEND_USD` (default $0.25). An answer that says "nothing was charged" costs nothing. The client signs at most $0.045 per call, only for USDC on Base, and only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`.

## Setup

```sh
cd examples/keyword-research-agent
npm install
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | yes, unless `--dry-run` | The 0x-prefixed private key of a Base wallet you control that holds a little USDC. Use a dedicated wallet with a small balance, and keep the key in the environment. |
| `DUO_MAX_SPEND_USD` | no | The most one run may cost. Default `0.25`. |

## Run

```sh
npx tsx agent.ts --dry-run "seo api"                     # prints the plan, spends nothing
DUO_PAYER_KEY=0x... npx tsx agent.ts "seo api"           # $0.085
DUO_PAYER_KEY=0x... npx tsx agent.ts "seo api" "rank tracker" --country gb --ideas 50 --trends 2   # $0.26: raise DUO_MAX_SPEND_USD
```

| Flag | Default | Meaning |
|---|---|---|
| `--country` | us | ISO 3166-1 alpha-2 market |
| `--ideas` | 20 | Ideas per seed (1-100, same price) |
| `--trends` | 1 | Google Trends checks per seed ($0.045 each) |
| `--min-volume` | 100 | Keep ideas with at least this many monthly searches |
| `--max-difficulty` | 60 | Keep ideas with keyword difficulty (0-100) at most this |
