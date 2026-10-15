# Crypto derivatives snapshot loop: perp funding, open interest, basis, liquidations and long/short per coin (Python, x402)

For each of your coins, once per round, one call to [`/v1/derivatives-snapshot`](https://derivs.duoleads.com/docs) returns the perp funding rates per exchange (with predicted funding), open interest per venue, the perp premium and the nearest futures basis, 24 h liquidations and the long/short ratio, across Bybit, Hyperliquid, dYdX, Gate, Kraken, Bitfinex, Deribit and OKX. The loop prints one line per coin and flags crowded positioning (high funding with a high long/short ratio, or deeply negative funding).

Data only, not investment advice.

## Cost

**$0.005 per coin per round**, paid in USDC on Base (x402 v2) from your wallet. No API key, no signup.

| Run | Calls | Cost |
|---|---|---|
| default: BTC, ETH, SOL x 4 rounds, 15 minutes apart | 12 | $0.06 |
| 10 coins every 15 minutes for one day | 960 | $4.80 |

The script prints the plan and its cost before it starts, and refuses to run when the plan costs more than `DUO_MAX_SPEND_USD` (default $0.10). A coin the service answers with "nothing was charged" (fewer than 3 venues, or a coin no venue lists) costs nothing. The client signs at most $0.005 per call, only USDC on Base, only to the service's address `0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39`.

## Setup

Python 3.10 or later.

```sh
cd examples/derivs-snapshot-loop-python
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

| Variable | Required | What it is |
|---|---|---|
| `DUO_PAYER_KEY` | yes, unless `--dry-run` | 0x-prefixed private key of a Base wallet you control that holds a little USDC. Use a dedicated low-balance wallet and keep the key in the environment. |
| `DUO_MAX_SPEND_USD` | no | Upper limit for one run. Default `0.10`. |

## Run

```sh
python snapshot_loop.py --dry-run                                  # prints the plan, spends nothing
DUO_PAYER_KEY=0x... python snapshot_loop.py                        # BTC, ETH, SOL x 4 rounds: $0.06
DUO_PAYER_KEY=0x... python snapshot_loop.py --coins BTC,ETH --rounds 2 --interval-min 5
```

Output:

```
-- round 1/4
   BTC  price 81,626.20  funding 5.31% APR  OI 15,119M USD  basis 6.14% ann.  liq 24h L/S 6.8M/1.3M  long/short 1.74
```

## In your own agent

`run_loop(derivs, coins, rounds, interval_min, sleep=..., log=...)` and `summarise(snapshot)` are importable. `derivs` is `DerivsClient(account)` or `DuoClient(account).derivs`.
