"""Client for https://api.duoleads.com. Each call costs $0.05 (x402 v2, USDC on Base)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit, urlunsplit

import requests
from x402 import SchemeRegistration, x402ClientConfig, x402ClientSync
from x402.http import x402HTTPClientSync
from x402.http.clients.requests import PaymentError, wrapRequestsWithPayment
from x402.http.utils import decode_payment_response_header
from x402.mechanisms.evm.exact.client import ExactEvmScheme

from .counterparty import CounterpartyResult, run_counterparty_check
from .errors import DuoApiError, PriceGuardError
from .generated import DuoMethods
from .price_guard import BASE_NETWORK, DEFAULT_MAX_PRICE_USD, DEFAULT_PAY_TO, guard_policy, requirement_problem, usd_to_atomic

DEFAULT_BASE_URL = "https://api.duoleads.com"
# urllib returns IPv6 hosts without brackets.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


@dataclass(frozen=True)
class PaidResult:
    """A route's result with the response meta and the settlement receipt (None when the header is absent)."""

    data: dict[str, Any]
    meta: dict[str, Any]
    receipt: Any


def normalise_base_url(raw: str) -> str:
    parts = urlsplit(raw)
    plain_loopback = parts.scheme == "http" and parts.hostname in _LOOPBACK_HOSTS
    if parts.scheme != "https" and not plain_loopback:
        raise ValueError(f"base_url must use https (plain http is only allowed for localhost): {raw}")
    if parts.query or parts.fragment:
        raise ValueError("base_url must not contain a query or a fragment")
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def assert_route_path(path: str) -> None:
    if not re.fullmatch(r"/v1/[a-z]+/[a-z0-9-]+", path):
        raise ValueError(f"not a route path: {path!r} (expected /v1/<group>/<name>)")


def _query_value(name: str, value: Any) -> str:
    # bool is a subclass of int, so it is checked first. The API expects "true" and "false".
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    raise TypeError(f"parameter {name} must be a string, number or boolean")


def _query(params: Mapping[str, Any]) -> dict[str, str]:
    return {name: _query_value(name, value) for name, value in params.items() if value is not None}


def _parse_json(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _receipt_of(response: requests.Response) -> Any:
    header = response.headers.get("PAYMENT-RESPONSE")
    if not header:
        return None
    try:
        return decode_payment_response_header(header)
    except ValueError:
        return None


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


def _price_guard_refusal(error: BaseException) -> PriceGuardError | None:
    """The PriceGuardError inside an x402 PaymentError chain, if there is one."""
    current: BaseException | None = error
    while current is not None:
        if isinstance(current, PriceGuardError):
            return current
        current = current.__cause__ or current.__context__
    return None


def _challenge_guard(max_atomic: int, max_price_usd: float, pay_to: str | None) -> Callable[[Any], None]:
    """Checks every option of a 402 challenge before the x402 client selects or signs anything.

    Runs as an on_payment_required hook. It refuses a challenge with no acceptable option, the same way the
    TypeScript client does. Any exception it raises reaches the caller wrapped in PaymentError, which
    _price_guard_refusal unwraps.
    """

    def check(context: Any) -> None:
        required = context.payment_required
        reasons: list[str] = []
        if required.x402_version != 2:
            reasons.append(f"x402Version {required.x402_version} is not 2")
        options = list(required.accepts or [])
        problems = [requirement_problem(option, max_atomic, pay_to) for option in options]
        if not options:
            reasons.append("the challenge offers no payment option")
        elif all(problem is not None for problem in problems):
            reasons.extend(problem for problem in problems if problem is not None)
        if reasons:
            raise PriceGuardError(reasons, max_price_usd)

    return check


def _paying_session(account: Any, max_atomic: int, max_price_usd: float, pay_to: str | None) -> requests.Session:
    config = x402ClientConfig(
        schemes=[SchemeRegistration(network=BASE_NETWORK, client=ExactEvmScheme(account))],
        policies=[guard_policy(max_atomic, max_price_usd, pay_to)],
        # The price guard is the only spend control. It is stricter (Base USDC only, at most max_price_usd),
        # and the payment layer's default-asset check would refuse the same requirements with a vaguer error.
        spend_controls=False,
    )
    http_client = x402HTTPClientSync(x402ClientSync.from_config(config)).on_payment_required(
        _challenge_guard(max_atomic, max_price_usd, pay_to)
    )
    return wrapRequestsWithPayment(requests.Session(), http_client)


class DuoClient(DuoMethods):
    """Typed methods for every route, plus call, call_with_receipt and check_counterparty.

    Pass `account` (an eth_account LocalAccount, or any object implementing x402's ClientEvmSigner) to pay
    with your wallet. The client refuses any price above `max_price_usd`, and any payee other than `pay_to`
    (default: the service's public address; None accepts any), before it signs. Pass `session`
    instead to use a requests.Session that already pays; the price guard cannot check payments made inside it.
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
    ) -> None:
        if (account is None) == (session is None):
            raise TypeError("pass exactly one of account (pays with your wallet) or session (a requests.Session that already pays)")
        max_atomic = usd_to_atomic(max_price_usd)
        self._base_url = normalise_base_url(base_url)
        self._max_price_usd = max_price_usd
        self._timeout = timeout
        self._session = session if session is not None else _paying_session(account, max_atomic, max_price_usd, pay_to)
        super().__init__(self.call)

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
                headers={"accept": "application/json"},
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
