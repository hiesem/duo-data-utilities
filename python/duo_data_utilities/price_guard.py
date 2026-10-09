"""Price guard: refuses any payment requirement the client must not sign. Mirrors src/price-guard.ts."""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Any

from x402.client_base import PaymentPolicy

from .errors import PriceGuardError

BASE_NETWORK = "eip155:8453"
BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
# The service's public receiving address. By default the client signs payments to this address only.
DEFAULT_PAY_TO = "0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39"
DEFAULT_MAX_PRICE_USD = 0.05


def usd_to_atomic(usd: float) -> int:
    """USD to atomic USDC units (6 decimals), rounded down so the cap is never exceeded."""
    if not math.isfinite(usd) or usd <= 0:
        raise ValueError(f"max_price_usd must be a positive number, got {usd}")
    atomic = math.floor(usd * 1_000_000 + 1e-6)  # the tolerance absorbs binary float error (0.57 * 1e6)
    if atomic < 1:
        raise ValueError("max_price_usd must be at least 0.000001 (one USDC base unit)")
    return atomic


def format_usd(atomic: int) -> str:
    """Atomic USDC units as a dollar string, e.g. 50000 is "$0.05"."""
    whole, fraction = divmod(atomic, 1_000_000)
    digits = f"{fraction:06d}".rstrip("0").ljust(2, "0")
    return f"${whole}.{digits}"


def requirement_problem(requirement: Any, max_atomic: int, pay_to: str | None = DEFAULT_PAY_TO) -> str | None:
    """Why one payment requirement is refused, or None when it may be signed."""
    scheme = getattr(requirement, "scheme", None)
    if scheme != "exact":
        return f"scheme {scheme!r} is not \"exact\""
    network = getattr(requirement, "network", None)
    if network != BASE_NETWORK:
        return f"network {network!r} is not {BASE_NETWORK} (Base)"
    asset = getattr(requirement, "asset", None)
    if not isinstance(asset, str) or asset.lower() != BASE_USDC_ADDRESS.lower():
        return f"asset {asset!r} is not Base USDC ({BASE_USDC_ADDRESS})"
    amount = getattr(requirement, "amount", None)
    if not isinstance(amount, str) or not re.fullmatch(r"[0-9]+", amount):
        return f"amount {amount!r} is not an integer in atomic USDC units"
    pay_to_seen = getattr(requirement, "pay_to", None)
    if pay_to is not None and (not isinstance(pay_to_seen, str) or pay_to_seen.lower() != pay_to.lower()):
        return f"payTo {pay_to_seen!r} is not the expected payee {pay_to}"
    value = int(amount)
    if value == 0:
        return "amount is zero"
    if value > max_atomic:
        return f"amount {amount} atomic units ({format_usd(value)}) is above the maximum {format_usd(max_atomic)}"
    return None


def guard_policy(max_atomic: int, max_price_usd: float, pay_to: str | None = DEFAULT_PAY_TO) -> PaymentPolicy:
    """Policy for the x402 client. Keeps only the requirements the guard accepts, and refuses the call if none remain.

    The x402 client runs policies before it selects a requirement and before it signs, so a refusal here
    means nothing is signed.
    """

    def policy(_x402_version: int, requirements: Sequence[Any]) -> list[Any]:
        allowed = [r for r in requirements if requirement_problem(r, max_atomic, pay_to) is None]
        if not allowed:
            reasons = [problem for r in requirements if (problem := requirement_problem(r, max_atomic, pay_to)) is not None]
            raise PriceGuardError(reasons, max_price_usd)
        return allowed

    return policy
