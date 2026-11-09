"""Client for https://api.duoleads.com. Each call costs $0.05 (x402 v2, USDC on Base)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import requests
from x402.http.clients.requests import PaymentError

from ._http import (
    _paying_session,
    _parse_json,
    _price_guard_refusal,
    _query,
    _receipt_of,
    assert_route_path,
    normalise_base_url,
)
from ._version import USER_AGENT
from .counterparty import CounterpartyResult, run_counterparty_check
from .derivs import DEFAULT_DERIVS_BASE_URL, DerivsClient
from .errors import DuoApiError
from .generated import DuoMethods
from .price_guard import DEFAULT_MAX_PRICE_USD, DEFAULT_PAY_TO, usd_to_atomic

DEFAULT_BASE_URL = "https://api.duoleads.com"


@dataclass(frozen=True)
class PaidResult:
    """A route's result with the response meta and the settlement receipt (None when the header is absent)."""

    data: dict[str, Any]
    meta: dict[str, Any]
    receipt: Any


def _api_error(path: str, response: requests.Response, body: Any) -> DuoApiError:
    status = response.status_code
    meta = body.get("meta") if isinstance(body, dict) else None
    request_id = meta.get("request_id") if isinstance(meta, dict) and isinstance(meta.get("request_id"), str) else None
    if isinstance(body, dict) and body.get("ok") is False and isinstance(body.get("error"), dict):
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
        return DuoApiError(
            code="PAYMENT_REQUIRED",
            message="the payment was not accepted (HTTP 402)",
            status=status,
            route=path,
            request_id=request_id,
        )
    if 200 <= status < 300:
        return DuoApiError(
            code="INVALID_RESPONSE",
            message=f"{path} did not return a valid response envelope (HTTP {status})",
            status=status,
            route=path,
            request_id=request_id,
        )
    return DuoApiError(code=f"HTTP_{status}", message=f"{path} failed with HTTP {status}", status=status, route=path, request_id=request_id)



class DuoClient(DuoMethods):
    """Typed methods for every route, plus call, call_with_receipt and check_counterparty.

    Pass `account` (an eth_account LocalAccount, or any object implementing x402's ClientEvmSigner) to pay
    with your wallet. The client refuses any price above `max_price_usd`, and any payee other than `pay_to`
    (default: the service's public address; None accepts any), before it signs. Pass `session`
    instead to use a requests.Session that already pays; the price guard cannot check payments made inside it.
    Every request carries `user_agent` (default USER_AGENT, naming the SDK and its version); to append your own
    product, pass f"{USER_AGENT} my-agent/1.0".

    `derivs` is a DerivsClient for https://derivs.duoleads.com (crypto derivatives data, $0.003 or $0.005 per
    call) on the same wallet or session, with its own price cap `derivs_max_price_usd` (default: each route's own
    listed price).
    """

    def __init__(
        self,
        account: Any = None,
        *,
        session: requests.Session | None = None,
        base_url: str = DEFAULT_BASE_URL,
        max_price_usd: float = DEFAULT_MAX_PRICE_USD,
        timeout: float | None = None,
        pay_to: str | None = DEFAULT_PAY_TO,
        user_agent: str = USER_AGENT,
        derivs_base_url: str = DEFAULT_DERIVS_BASE_URL,
        derivs_max_price_usd: float | None = None,
    ) -> None:
        if (account is None) == (session is None):
            raise TypeError("pass exactly one of account (pays with your wallet) or session (a requests.Session that already pays)")
        if "\r" in user_agent or "\n" in user_agent:
            raise ValueError("user_agent must not contain line breaks")
        max_atomic = usd_to_atomic(max_price_usd)
        self._user_agent = user_agent
        self._base_url = normalise_base_url(base_url)
        self._max_price_usd = max_price_usd
        self._timeout = timeout
        self._session = session if session is not None else _paying_session(account, max_atomic, max_price_usd, pay_to)
        super().__init__(self.call)
        self.derivs = DerivsClient(
            account if session is None else None,
            session=session,
            base_url=derivs_base_url,
            max_price_usd=derivs_max_price_usd,
            timeout=timeout,
            pay_to=pay_to,
            user_agent=user_agent,
        )

    def call(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Calls any route by path and returns its `data` object. Costs $0.05 per call."""
        return self.call_with_receipt(path, params).data

    def call_with_receipt(self, path: str, params: Mapping[str, Any] | None = None) -> PaidResult:
        """Like `call`, and also returns the response meta and the settlement receipt."""
        assert_route_path(path)
        try:
            response = self._session.get(
                f"{self._base_url}{path}",
                params=_query(params or {}),
                headers={"accept": "application/json", "User-Agent": self._user_agent},
                timeout=self._timeout,
            )
        except PaymentError as error:
            refusal = _price_guard_refusal(error)
            if refusal is not None:
                raise refusal from error
            raise
        body = _parse_json(response)
        if 200 <= response.status_code < 300 and isinstance(body, dict) and body.get("ok") is True and "data" in body:
            meta = body.get("meta")
            return PaidResult(data=body["data"], meta=meta if isinstance(meta, dict) else {}, receipt=_receipt_of(response))
        raise _api_error(path, response, body)

    def check_counterparty(self, *, iban: str, country: str, tax_id_type: str, tax_id: str) -> CounterpartyResult:
        """Runs IBAN, tax ID and country checks: three calls, $0.15. Structure and checksum only."""
        return run_counterparty_check(self, iban=iban, country=country, tax_id_type=tax_id_type, tax_id=tax_id)
