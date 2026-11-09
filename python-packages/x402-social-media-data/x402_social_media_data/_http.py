# Copied from python/duo_data_utilities/_http.py by python/scripts/generate.py. Do not edit here.
"""HTTP plumbing shared by DuoClient (api.duoleads.com) and DerivsClient (derivs.duoleads.com)."""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit, urlunsplit

import requests
from x402 import SchemeRegistration, x402ClientConfig, x402ClientSync
from x402.http import x402HTTPClientSync
from x402.http.clients.requests import wrapRequestsWithPayment
from x402.http.utils import decode_payment_response_header
from x402.mechanisms.evm.exact.client import ExactEvmScheme

from .errors import PriceGuardError
from .price_guard import BASE_NETWORK, guard_policy, requirement_problem

# urllib returns IPv6 hosts without brackets.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


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
