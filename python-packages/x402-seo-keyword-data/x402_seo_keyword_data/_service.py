# Copied from python/duo_data_utilities/_service.py by python/scripts/generate.py. Do not edit here.
"""Shared client core for the services whose answer is the JSON body itself (derivs, keywords, social).

Each of them differs from the main API in the same ways: a 200 answer is the data object (no {ok, data, meta}
envelope), an error answer is {"error": {...}, "request_id": ...}, and every route has its own price, so the price
guard caps each route at its own listed price unless the caller passes one max_price_usd for all of them.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import requests
from x402.http.clients.requests import PaymentError

from ._http import _parse_json, _paying_session, _price_guard_refusal, _receipt_of, normalise_base_url
from ._version import USER_AGENT
from .errors import DuoApiError
from .price_guard import DEFAULT_PAY_TO, usd_to_atomic


@dataclass(frozen=True)
class ServicePaidResult:
    """An answer (its JSON body) with the settlement receipt (None when the header is absent)."""

    data: dict[str, Any]
    receipt: Any


def plain_number(name: str, value: Any) -> str:
    """A number as a plain decimal (no exponent, at most 8 decimals). bool is refused by the callers first."""
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise TypeError(f"parameter {name} must be a finite number")
    if value.is_integer():
        return str(int(value))
    return f"{value:.8f}".rstrip("0").rstrip(".")


def scalar_query_value(name: str, value: Any) -> str:
    """A query value as the services read it: "true"/"false", plain decimals, strings unchanged."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return plain_number(name, value)
    if isinstance(value, str):
        return value
    raise TypeError(f"parameter {name} must be a string, number or boolean")


def json_body(params: Mapping[str, Any]) -> bytes:
    """The JSON body of a POST route: None members are dropped; NaN and infinity are refused."""
    body = {name: value for name, value in params.items() if value is not None}
    try:
        return json.dumps(body, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except ValueError as error:
        raise TypeError(f"the request body must be finite JSON: {error}") from error
    except TypeError as error:
        raise TypeError(f"the request body must be JSON: {error}") from error


def flat_error(path: str, response: requests.Response, body: Any) -> DuoApiError:
    """DuoApiError for an answer that is not a 2xx JSON object without an `error` member."""
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


class PerRouteCapClient:
    """Wallet or session handling, the per-route price cap and one request with the flat error mapping.

    Subclasses set `_route_caps` (path -> USD, each route's own listed price) and `_unknown_path_cap` (the cap
    for a path the client does not know).
    """

    _route_caps: Mapping[str, float] = {}
    _unknown_path_cap: float = 0.0

    def __init__(
        self,
        account: Any = None,
        *,
        session: requests.Session | None,
        base_url: str,
        max_price_usd: float | None,
        timeout: float | None,
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

    def _cap_for(self, path: str) -> float:
        if self._max_price_usd is not None:
            return self._max_price_usd
        return self._route_caps.get(path, self._unknown_path_cap)

    def _session_for(self, path: str) -> requests.Session:
        if self._session is not None:
            return self._session
        cap = self._cap_for(path)
        if cap not in self._sessions:
            self._sessions[cap] = _paying_session(self._account, usd_to_atomic(cap), cap, self._pay_to)
        return self._sessions[cap]

    def _send(self, path: str, *, query: Mapping[str, str] | None = None, body: bytes | None = None) -> ServicePaidResult:
        """GET with `query`, or POST with the JSON `body`; returns the JSON object or raises DuoApiError."""
        headers = {"accept": "application/json", "User-Agent": self._user_agent}
        session = self._session_for(path)
        url = f"{self._base_url}{path}"
        try:
            if body is None:
                response = session.get(url, params=dict(query or {}), headers=headers, timeout=self._timeout)
            else:
                headers["content-type"] = "application/json"
                response = session.post(url, data=body, headers=headers, timeout=self._timeout)
        except PaymentError as error:
            refusal = _price_guard_refusal(error)
            if refusal is not None:
                raise refusal from error
            raise
        parsed = _parse_json(response)
        if 200 <= response.status_code < 300 and isinstance(parsed, dict) and "error" not in parsed:
            return ServicePaidResult(data=parsed, receipt=_receipt_of(response))
        raise flat_error(path, response, parsed)
