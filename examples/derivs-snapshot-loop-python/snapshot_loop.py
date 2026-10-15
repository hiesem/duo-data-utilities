"""Per-coin crypto derivatives snapshot loop: perp funding rates, open interest, futures basis, liquidations
and the long/short ratio for each of your coins, in one paid call per coin per round.

Each call is GET https://derivs.duoleads.com/v1/derivatives-snapshot?coin=<COIN> (Bybit, Hyperliquid, dYdX,
Gate, Kraken, Bitfinex, Deribit, OKX). The loop prints one line per coin and flags crowded positioning:
high average funding APR together with a high long/short ratio, or deeply negative funding. Data only, not
investment advice.

COST, stated upfront: $0.005 per coin per round, paid in USDC on Base via x402 from YOUR wallet
(DUO_PAYER_KEY). The default run is 3 coins (BTC, ETH, SOL) x 4 rounds = 12 calls = $0.06. A coin the
service answers with "nothing was charged" (too few venues, or a coin no venue lists) costs nothing.
The run refuses to start when coins x rounds x $0.005 is above DUO_MAX_SPEND_USD (default $0.10).
Run with --dry-run first: it prints the plan and spends nothing.

    python snapshot_loop.py --dry-run
    DUO_PAYER_KEY=0x... python snapshot_loop.py --coins BTC,ETH,SOL --rounds 4 --interval-min 15
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

PRICE_USD = 0.005  # one /v1/derivatives-snapshot call

# Flags (simple screens, not signals).
CROWDED_LONG_APR = 30.0  # average funding APR in percent
CROWDED_LONG_RATIO = 2.0  # accounts long / accounts short
CROWDED_SHORT_APR = -15.0


@dataclass
class CoinLine:
    coin: str
    price: float | None
    avg_funding_apr: float | None
    oi_usd: float | None
    nearest_basis_apr: float | None
    liq_long_usd: float | None
    liq_short_usd: float | None
    long_short: float | None
    flags: list[str] = field(default_factory=list)


def plan(coins: Sequence[str], rounds: int) -> tuple[int, float]:
    """Number of paid calls and the maximum cost in USD."""
    calls = len(coins) * rounds
    return calls, calls * PRICE_USD


def summarise(snapshot: dict[str, Any]) -> CoinLine:
    """One line of numbers from a /v1/derivatives-snapshot answer."""
    funding = snapshot.get("funding") or {}
    summary = funding.get("summary") or {}
    basis = snapshot.get("basis") or {}
    nearest = basis.get("nearest_future") or {}
    liq = snapshot.get("liquidations_24h") or {}
    ratios = [row["ratio"] for row in snapshot.get("long_short") or [] if isinstance(row.get("ratio"), (int, float))]
    line = CoinLine(
        coin=snapshot.get("coin", "?"),
        price=snapshot.get("price"),
        avg_funding_apr=summary.get("avg_apr_pct"),
        oi_usd=(snapshot.get("open_interest") or {}).get("total_usd"),
        nearest_basis_apr=nearest.get("annualised_basis_pct"),
        liq_long_usd=liq.get("long_usd"),
        liq_short_usd=liq.get("short_usd"),
        long_short=statistics.median(ratios) if ratios else None,
    )
    if line.avg_funding_apr is not None and line.avg_funding_apr >= CROWDED_LONG_APR and (line.long_short or 0) >= CROWDED_LONG_RATIO:
        line.flags.append("crowded long (high funding, high long/short)")
    if line.avg_funding_apr is not None and line.avg_funding_apr <= CROWDED_SHORT_APR:
        line.flags.append("crowded short (deeply negative funding)")
    return line


def _fmt(value: float | None, spec: str, suffix: str = "") -> str:
    return "n/a" if value is None else f"{value:{spec}}{suffix}"


def format_line(line: CoinLine) -> str:
    text = (
        f"{line.coin:>6}  price {_fmt(line.price, ',.2f')}  funding {_fmt(line.avg_funding_apr, '.2f', '% APR')}  "
        f"OI {_fmt(None if line.oi_usd is None else line.oi_usd / 1e6, ',.0f', 'M USD')}  "
        f"basis {_fmt(line.nearest_basis_apr, '.2f', '% ann.')}  "
        f"liq 24h L/S {_fmt(None if line.liq_long_usd is None else line.liq_long_usd / 1e6, '.1f', 'M')}"
        f"/{_fmt(None if line.liq_short_usd is None else line.liq_short_usd / 1e6, '.1f', 'M')}  "
        f"long/short {_fmt(line.long_short, '.2f')}"
    )
    return text + ("  <- " + "; ".join(line.flags) if line.flags else "")


def run_loop(
    derivs: Any,
    coins: Sequence[str],
    rounds: int,
    interval_min: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> tuple[list[CoinLine], int]:
    """Calls the snapshot for every coin, every round. Returns the lines and the number of paid calls."""
    from duo_data_utilities import DuoApiError

    lines: list[CoinLine] = []
    paid = 0
    for round_no in range(1, rounds + 1):
        log(f"-- round {round_no}/{rounds}")
        for coin in coins:
            try:
                snapshot = derivs.derivatives_snapshot(coin=coin)
            except DuoApiError as error:
                # 400 (bad input), 404 (coin listed nowhere) and 503 (too few venues) are not charged.
                log(f"{coin:>6}  skipped, not charged: {error.code} {error}")
                continue
            paid += 1
            line = summarise(snapshot)
            lines.append(line)
            log(format_line(line))
        if round_no < rounds:
            sleep(interval_min * 60)
    return lines, paid


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--coins", default="BTC,ETH,SOL", help="comma-separated coins (default BTC,ETH,SOL)")
    parser.add_argument("--rounds", type=int, default=4, help="rounds over all coins (default 4)")
    parser.add_argument("--interval-min", type=float, default=15, help="minutes between rounds (default 15)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and its cost, spend nothing")
    args = parser.parse_args(argv)
    coins = [c.strip().upper() for c in args.coins.split(",") if c.strip()]
    if not coins or args.rounds < 1:
        parser.error("need at least one coin and one round")

    calls, cost = plan(coins, args.rounds)
    print(f"Plan: {args.rounds} rounds x {len(coins)} coins ({', '.join(coins)}) = {calls} calls to /v1/derivatives-snapshot, at most ${cost:.3f} in USDC on Base (${PRICE_USD} per call).")
    if args.dry_run:
        print("Dry run: nothing was sent or paid.")
        return 0
    max_spend = float(os.environ.get("DUO_MAX_SPEND_USD", "0.10"))
    if cost > max_spend + 1e-9:
        print(f"This run can cost ${cost:.3f}, above DUO_MAX_SPEND_USD=${max_spend:.2f}. Lower --rounds or --coins.", file=sys.stderr)
        return 2
    key = os.environ.get("DUO_PAYER_KEY", "")
    if not key.startswith("0x"):
        print("Set DUO_PAYER_KEY to the 0x-prefixed private key of a Base wallet holding a little USDC.", file=sys.stderr)
        return 2

    from eth_account import Account

    from duo_data_utilities import USER_AGENT, DerivsClient

    # The client signs at most $0.005 per call, only USDC on Base, only to the service's address.
    derivs = DerivsClient(Account.from_key(key), user_agent=f"{USER_AGENT} derivs-snapshot-loop/1.0", timeout=30)
    _lines, paid = run_loop(derivs, coins, args.rounds, args.interval_min)
    print(f"Done: {paid} paid calls, ${paid * PRICE_USD:.3f} spent.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
