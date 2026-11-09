# Copied from python/duo_data_utilities/social.py by python/scripts/generate.py. Do not edit here.
"""Client for https://social.duoleads.com: social media data for social listening and research, paid per call over
x402 (USDC on Base).

26 routes: public posts, profiles, comments and search on X (Twitter), Reddit, TikTok, Instagram, YouTube, Threads,
Facebook ads, LinkedIn, Bluesky and Hacker News, cross-platform search and mentions. $0.01 to $0.025 per call.
Mirrors src/social.ts.

Differences from the main API handled here: paths are /v1/<platform>/<name>; every route is GET with a query
string; a 200 answer is the data object itself (no {ok, data, meta} envelope); an error answer is
{"error": {...}, "request_id": ...}.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

import requests

from ._service import PerRouteCapClient, ServicePaidResult, scalar_query_value
from ._version import USER_AGENT
from .price_guard import DEFAULT_PAY_TO
from .social_generated import SOCIAL_ROUTES, SocialMethods

DEFAULT_SOCIAL_BASE_URL = "https://social.duoleads.com"
# The cap for a path the client does not know (the most expensive route, social search, costs $0.025). Every
# listed route is capped by default at its own price.
DEFAULT_SOCIAL_MAX_PRICE_USD = 0.025
# Paid MCP endpoint (Streamable HTTP; payment in params._meta["x402/payment"]).
SOCIAL_MCP_URL = "https://social.duoleads.com/mcp"

_ROUTE_CAP_USD: dict[str, float] = {r["path"]: float(r["price_usd"]) for r in SOCIAL_ROUTES}

# A social answer (its JSON body) with the settlement receipt (None when the header is absent).
SocialPaidResult = ServicePaidResult


def assert_social_path(path: str) -> None:
    if not re.fullmatch(r"/v1/[a-z0-9]+/[a-z0-9-]+", path):
        raise ValueError(f"not a social route path: {path!r} (expected /v1/<platform>/<name>)")


def social_query(params: Mapping[str, Any]) -> dict[str, str]:
    """Query parameters: strings, finite numbers and booleans ("true"/"false"); None is omitted."""
    return {name: scalar_query_value(name, value) for name, value in params.items() if value is not None}


class SocialClient(PerRouteCapClient, SocialMethods):
    """Typed methods for the 26 social routes, plus call and call_with_receipt.

    Pass `account` to pay with your wallet; the client refuses any price above `max_price_usd` (by default each
    route's own listed price, $0.01, $0.02 or $0.025, and 0.025 for a path it does not know; pass 0.01 to allow
    the $0.01 routes only), any network but Base, any asset but USDC and any payee but `pay_to`, before it signs.
    Pass `session` instead to use a requests.Session that already pays.
    `DuoClient(...).social` is the same client, sharing the wallet with the main API.

    Answers are third parties' public data: read the service's terms and privacy notice, and do not use the data
    to profile, target or train AI on individuals.
    """

    _route_caps = _ROUTE_CAP_USD
    _unknown_path_cap = DEFAULT_SOCIAL_MAX_PRICE_USD

    def __init__(
        self,
        account: Any = None,
        *,
        session: requests.Session | None = None,
        base_url: str = DEFAULT_SOCIAL_BASE_URL,
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
        SocialMethods.__init__(self, self.call)

    def call(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Calls any social route by path (e.g. /v1/bluesky/search) and returns its JSON body."""
        return self.call_with_receipt(path, params).data

    def call_with_receipt(self, path: str, params: Mapping[str, Any] | None = None) -> SocialPaidResult:
        """Like `call`, and also returns the settlement receipt."""
        assert_social_path(path)
        return self._send(path, query=social_query(params or {}))
