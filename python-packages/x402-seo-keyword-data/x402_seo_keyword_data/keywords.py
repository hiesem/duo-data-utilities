# Copied from python/duo_data_utilities/keywords.py by python/scripts/generate.py. Do not edit here.
"""Client for https://keywords.duoleads.com: SEO and keyword data, paid per call over x402 (USDC on Base).

44 routes: Google search volume, CPC, competition, keyword difficulty and intent (Google Ads data), keyword ideas,
Google Trends, domain and ranking data, backlinks, on-page and PageSpeed audits, Amazon keywords, Google / Bing /
YouTube / Maps results, brand and AI-answer visibility, tech stack and WHOIS. $0.012 to $0.25 per call.
Mirrors src/keywords.ts.

Differences from the main API handled here: paths are /v1/<name> (one segment); each route has one HTTP method
(SEO_KEYWORD_ROUTES): most are POST with a JSON body, the others GET; a 200 answer is the data object itself (no
{ok, data, meta} envelope); an error answer is {"error": {...}, "request_id": ...}.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

import requests

from ._service import PerRouteCapClient, ServicePaidResult, json_body, scalar_query_value
from ._version import USER_AGENT
from .keywords_generated import SEO_KEYWORD_ROUTES, KeywordsMethods
from .price_guard import DEFAULT_PAY_TO

DEFAULT_KEYWORDS_BASE_URL = "https://keywords.duoleads.com"
# The cap for a path the client does not know. Every listed route is capped by default at its own price.
DEFAULT_KEYWORDS_MAX_PRICE_USD = 0.045
# The most expensive keyword route (historical-rank), in USD.
KEYWORDS_MAX_ROUTE_PRICE_USD = 0.25
# Paid MCP endpoint (Streamable HTTP; payment in params._meta["x402/payment"]).
KEYWORDS_MCP_URL = "https://keywords.duoleads.com/mcp"

_ROUTE_CAP_USD: dict[str, float] = {r["path"]: float(r["price_usd"]) for r in SEO_KEYWORD_ROUTES}
_POST_PATHS = frozenset(r["path"] for r in SEO_KEYWORD_ROUTES if r["http_method"] == "POST")

# A keyword answer (its JSON body) with the settlement receipt (None when the header is absent).
KeywordsPaidResult = ServicePaidResult


def assert_keywords_path(path: str) -> None:
    if not re.fullmatch(r"/v1/[a-z0-9-]+", path):
        raise ValueError(f"not a keyword route path: {path!r} (expected /v1/<name>)")


def keywords_query(params: Mapping[str, Any]) -> dict[str, str]:
    """Query parameters of a GET keyword route. A list becomes the comma-separated list the API reads; an element
    that is not a string or contains a comma is refused (it would silently become two keywords). None is omitted."""
    query: dict[str, str] = {}
    for name, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for i, item in enumerate(value):
                if not isinstance(item, str) or "," in item:
                    raise TypeError(f"{name}[{i}] must be a string without commas (one keyword per element)")
            query[name] = ",".join(value)
        else:
            query[name] = scalar_query_value(name, value)
    return query


class KeywordsClient(PerRouteCapClient, KeywordsMethods):
    """Typed methods for the 44 keyword routes, plus call and call_with_receipt.

    Pass `account` to pay with your wallet; the client refuses any price above `max_price_usd` (by default each
    route's own listed price, $0.012 to $0.25, and 0.045 for a path it does not know; pass 0.04 to refuse every
    route above $0.04), any network but Base, any asset but USDC and any payee but `pay_to`, before it signs.
    Pass `session` instead to use a requests.Session that already pays.
    `DuoClient(...).keywords` is the same client, sharing the wallet with the main API.
    """

    _route_caps = _ROUTE_CAP_USD
    _unknown_path_cap = DEFAULT_KEYWORDS_MAX_PRICE_USD

    def __init__(
        self,
        account: Any = None,
        *,
        session: requests.Session | None = None,
        base_url: str = DEFAULT_KEYWORDS_BASE_URL,
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
        KeywordsMethods.__init__(self, self.call)

    def call(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Calls any keyword route by path (e.g. /v1/keyword-gap) with the route's own HTTP method (POST with a
        JSON body, or GET) and returns its JSON body."""
        return self.call_with_receipt(path, params).data

    def call_with_receipt(self, path: str, params: Mapping[str, Any] | None = None) -> KeywordsPaidResult:
        """Like `call`, and also returns the settlement receipt."""
        assert_keywords_path(path)
        if path in _POST_PATHS:
            return self._send(path, body=json_body(params or {}))
        return self._send(path, query=keywords_query(params or {}))
