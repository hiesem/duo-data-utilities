"""Client for https://derivs.duoleads.com: crypto derivatives data, paid per call over x402 (USDC on Base).

Perp funding rates, funding history and arbitrage, a perp screener, open interest, futures basis, implied
volatility, liquidations, order book depth and a one-call snapshot, across Bybit, Hyperliquid, dYdX, Gate,
Kraken, Bitfinex, Deribit and OKX. $0.003 or $0.005 per call. Mirrors src/derivs.ts.

Differences from the main API handled here: paths are /v1/<name> (one segment), a 200 answer is the data
object itself (no {ok, data, meta} envelope), and an error answer is {"error": {...}, "request_id": ...}.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

import requests

from ._service import PerRouteCapClient, ServicePaidResult, flat_error, scalar_query_value
from ._version import USER_AGENT
from .derivs_generated import DERIVS_ROUTES, DerivsMethods
from .price_guard import DEFAULT_PAY_TO

DEFAULT_DERIVS_BASE_URL = "https://derivs.duoleads.com"
# The cap for a path the client does not know (the most expensive derivs route costs $0.005). Every listed route
# is capped by default at its own price, $0.003 or $0.005.
DEFAULT_DERIVS_MAX_PRICE_USD = 0.005
# Default cap per path when the caller passed no max_price_usd: each route's own price.
_ROUTE_CAP_USD: dict[str, float] = {r["path"]: float(r["price_usd"]) for r in DERIVS_ROUTES}
# Paid MCP endpoint (Streamable HTTP; payment in params._meta["x402/payment"]).
DERIVS_MCP_URL = "https://derivs.duoleads.com/mcp"

# A derivs answer (its JSON body) with the settlement receipt (None when the header is absent).
DerivsPaidResult = ServicePaidResult


def assert_derivs_path(path: str) -> None:
    if not re.fullmatch(r"/v1/[a-z0-9-]+", path):
        raise ValueError(f"not a derivs route path: {path!r} (expected /v1/<name>)")


def derivs_query_value(name: str, value: Any) -> str:
    """A query value as the derivs API reads it: numbers as plain decimals (no exponent, at most 8 decimals)."""
    return scalar_query_value(name, value)


def derivs_query(params: Mapping[str, Any]) -> dict[str, str]:
    return {name: derivs_query_value(name, value) for name, value in params.items() if value is not None}


_derivs_error = flat_error


class DerivsClient(PerRouteCapClient, DerivsMethods):
    """Typed methods for the 10 derivs routes, plus call and call_with_receipt.

    Pass `account` to pay with your wallet; the client refuses any price above `max_price_usd` (by default
    each route's own listed price, $0.003 or $0.005, and 0.005 for a path it does not know; pass 0.003 to
    refuse the $0.005 routes), any network but Base, any asset but USDC and any payee but `pay_to`, before
    it signs. Pass `session` instead to use a requests.Session that already pays.
    `DuoClient(...).derivs` is the same client, sharing the wallet with the main API.
    """

    _route_caps = _ROUTE_CAP_USD
    _unknown_path_cap = DEFAULT_DERIVS_MAX_PRICE_USD

    def __init__(
        self,
        account: Any = None,
        *,
        session: requests.Session | None = None,
        base_url: str = DEFAULT_DERIVS_BASE_URL,
        max_price_usd: float | None = None,
        timeout: float | None = None,
        pay_to: str | None = DEFAULT_PAY_TO,
        user_agent: str = USER_AGENT,
    ) -> None:
        PerRouteCapClient.__init__(
            self,
            account,
            session=session,
            base_url=base_url,
            max_price_usd=max_price_usd,
            timeout=timeout,
            pay_to=pay_to,
            user_agent=user_agent,
        )
        DerivsMethods.__init__(self, self.call)

    def call(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Calls any derivs route by path (e.g. /v1/funding-rates) and returns its JSON body."""
        return self.call_with_receipt(path, params).data

    def call_with_receipt(self, path: str, params: Mapping[str, Any] | None = None) -> DerivsPaidResult:
        """Like `call`, and also returns the settlement receipt."""
        assert_derivs_path(path)
        return self._send(path, query=derivs_query(params or {}))
