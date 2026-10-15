# Funding rate arbitrage watcher: perp funding spreads across 8 exchanges, paid per scan with x402 (TypeScript)

Watches perpetual futures funding rates on Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX and prints every new funding arbitrage opportunity: the coin, which venue to be long and which to be short, the gross and fee-adjusted net APR, and the breakeven days. One call to [`/v1/funding-arbitrage`](https://derivs.duoleads.com/docs) per scan covers every coin.

Data only, not investment advice.

## Cost

**$0.005 per scan**, paid in USDC on Base (x402 v2) from your wallet. No API key, no signup.

| Run | Scans | Cost |
|---|---|---|
| default (`--scans 12 --interval-min 5`, one hour) | 12 | $0.06 |
| one day at 15-minute scans (`--scans 96 --interval-min 15`) | 96 | $0.48 |

The script prints the plan and its cost before it starts, and refuses to run when the plan costs more than `DUO_MAX_SPEND_USD` (default $0.10). A scan the service answers with "nothing was charged" (fewer than 3 venues answered) costs nothing. The client signs at most $0.005 per call, only USDC on Base, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`.

## Setup

```sh
cd examples/funding-arbitrage-watcher
npm install
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | yes, unless `--dry-run` | 0x-prefixed private key of a Base wallet you control that holds a little USDC. Use a dedicated low-balance wallet and keep the key in the environment. |
| `DUO_MAX_SPEND_USD` | no | Upper limit for one run. Default `0.10`. |

## Run

```sh
npx tsx watcher.ts --dry-run                       # prints the plan, spends nothing
DUO_PAYER_KEY=0x... npx tsx watcher.ts             # 12 scans, 5 minutes apart: $0.06
DUO_PAYER_KEY=0x... npx tsx watcher.ts --scans 4 --interval-min 15 --min-net-apr 30 --min-volume-usd 5000000
```

| Flag | Default | Meaning |
|---|---|---|
| `--scans` | 12 | Number of scans (paid calls) |
| `--interval-min` | 5 | Minutes between scans |
| `--min-net-apr` | 20 | Alert when the fee-adjusted net APR is at least this, in percent |
| `--min-volume-usd` | 1000000 | Both legs need at least this 24 h volume (USD) |
| `--fee-pct` | 0.05 | Taker fee per fill, percent (4 fills per round trip) |
| `--holding-days` | 30 | Holding period used to amortise the fees |

Output:

```
[scan 1/12] 2026-10-14T23:00:00Z 188 coins, 20 spreads >= 20% gross, 3 new
  ETC: long bitfinex / short hyperliquid  net 75.6% APR (gross 78.0%), breakeven 0.94 d
```

## In your own agent

`runWatcher(client, options, { sleep, log })` and `freshAlerts(seen, opportunities, minNetApr, scan)` are exported. `client` is `createDerivsClient({ account })` or `createClient({ account }).derivs`.
