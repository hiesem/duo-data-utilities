"""Client for https://derivs.duoleads.com: crypto derivatives data, paid per call over x402 (USDC on Base).

Perp funding rates, funding history and arbitrage, a perp screener, open interest, futures basis, implied
volatility, liquidations, order book depth and a one-call snapshot, across Bybit, Hyperliquid, dYdX, Gate,
Kraken, Bitfinex, Deribit and OKX. $0.003 or $0.005 per call. Mirrors src/derivs.ts.

Differences from the main API handled here: paths are /v1/<name> (one segment), a 200 answer is the data
object itself (no {ok, data, meta} envelope), and an error answer is {"error": {...}, "request_id": ...}.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Mapping

import requests
from x402.http.clients.requests import PaymentError

from ._http import _parse_json, _paying_session, _price_guard_refusal, _receipt_of, normalise_base_url
from ._version import USER_AGENT
from .derivs_generated import DERIVS_ROUTES, DerivsMethods
from .errors import DuoApiError
from .price_guard import DEFAULT_PAY_TO, usd_to_atomic

DEFAULT_DERIVS_BASE_URL = "https://derivs.duoleads.com"
# The cap for a path the client does not know (the most expensive derivs route costs $0.005). Every listed route
# is capped by default at its own price, $0.003 or $0.005.
DEFAULT_DERIVS_MAX_PRICE_USD = 0.005
# Default cap per path when the caller passed no max_price_usd: each route's own price.
_ROUTE_CAP_USD: dict[str, float] = {r["path"]: float(r["price_usd"]) for r in DERIVS_ROUTES}
# Paid MCP endpoint (Streamable HTTP; payment in params._meta["x402/payment"]).
DERIVS_MCP_URL = "https://derivs.duoleads.com/mcp"


@dataclass(frozen=True)
class DerivsPaidResult:
    """A derivs answer (its JSON body) with the settlement receipt (None when the header is absent)."""

    data: dict[str, Any]
    receipt: Any


def assert_derivs_path(path: str) -> None:
    if not re.fullmatch(r"/v1/[a-z0-9-]+", path):
        raise ValueError(f"not a derivs route path: {path!r} (expected /v1/<name>)")


def derivs_query_value(name: str, value: Any) -> str:
    """A query value as the derivs API reads it: numbers as plain decimals (no exponent, at most 8 decimals)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError(f"parameter {name} must be a finite number")
        if value.is_integer():
            return str(int(value))
        return f"{value:.8f}".rstrip("0").rstrip(".")
    if isinstance(value, str):
        return value
    raise TypeError(f"parameter {name} must be a string, number or boolean")


def derivs_query(params: Mapping[str, Any]) -> dict[str, str]:
    return {name: derivs_query_value(name, value) for name, value in params.items() if value is not None}


def _derivs_error(path: str, response: requests.Response, body: Any) -> DuoApiError:
    status = response.status_code
    request_id = body.get("request_id") if isinstance(body, dict) and isinstance(body.get("request_id"), str) else None
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        error = body["error"]
        return DuoApiError(
            code=str(error.get("code") or "UNKNOWN_ERROR"),
            message=str(error.get("message") or f"{path} failed with HTTP {status}"),
            param=error.get("param") if isinstance(error.get("param"), str) else None,
            expected=error.get("expected") if isinstance(error.get("expected"), str) else None,
            status=status,
            route=path,
            request_id=request_id,
        )
    if status == 402:
        return DuoApiError(code="PAYMENT_REQUIRED", message="the payment was not accepted (HTTP 402)", status=status, route=path, request_id=request_id)
    if 200 <= status < 300:
        return DuoApiError(code="INVALID_RESPONSE", message=f"{path} did not return a JSON object (HTTP {status})", status=status, route=path, request_id=request_id)
    return DuoApiError(code=f"HTTP_{status}", message=f"{path} failed with HTTP {status}", status=status, route=path, request_id=request_id)


class DerivsClient(DerivsMethods):
    """Typed methods for the 10 derivs routes, plus call and call_with_receipt.

    Pass `account` to pay with your wallet; the client refuses any price above `max_price_usd` (by default
    each route's own listed price, $0.003 or $0.005, and 0.005 for a path it does not know; pass 0.003 to
    refuse the $0.005 routes), any network but Base, any asset but USDC and any payee but `pay_to`, before
    it signs. Pass `session` instead to use a requests.Session that already pays.
    `DuoClient(...).derivs` is the same client, sharing the wallet with the main API.
    """

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
        if (account is None) == (session is None):
            raise TypeError("pass exactly one of account (pays with your wallet) or session (a requests.Session that already pays)")
        if "\r" in user_agent or "\n" in user_agent:
            raise ValueError("user_agent must not contain line breaks")
        if max_price_usd is not None:
            usd_to_atomic(max_price_usd)  # validates it at construction
        self._user_agent = user_agent
        self._base_url = normalise_base_url(base_url)
        self._max_price_usd = max_price_usd
        self._timeout = timeout
        self._account = account
        self._pay_to = pay_to
        self._session = session
        # One paying session per price cap (at most one per distinct route price), built on first use.
        self._sessions: dict[float, requests.Session] = {}
        super().__init__(self.call)

    def _cap_for(self, path: str) -> float:
        if self._max_price_usd is not None:
            return self._max_price_usd
        return _ROUTE_CAP_USD.get(path, DEFAULT_DERIVS_MAX_PRICE_USD)

    def _session_for(self, path: str) -> requests.Session:
        if self._session is not None:
            return self._session
        cap = self._cap_for(path)
        if cap not in self._sessions:
            self._sessions[cap] = _paying_session(self._account, usd_to_atomic(cap), cap, self._pay_to)
        return self._sessions[cap]

    def call(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Calls any derivs route by path (e.g. /v1/funding-rates) and returns its JSON body."""
        return self.call_with_receipt(path, params).data

    def call_with_receipt(self, path: str, params: Mapping[str, Any] | None = None) -> DerivsPaidResult:
        """Like `call`, and also returns the settlement receipt."""
        assert_derivs_path(path)
        try:
            response = self._session_for(path).get(
                f"{self._base_url}{path}",
                params=derivs_query(params or {}),
                headers={"accept": "application/json", "User-Agent": self._user_agent},
                timeout=self._timeout,
            )
        except PaymentError as error:
            refusal = _price_guard_refusal(error)
            if refusal is not None:
                raise refusal from error
            raise
        body = _parse_json(response)
        if 200 <= response.status_code < 300 and isinstance(body, dict) and "error" not in body:
            return DerivsPaidResult(data=body, receipt=_receipt_of(response))
        raise _derivs_error(path, response, body)
