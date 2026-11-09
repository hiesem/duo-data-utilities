"""x402-seo-keyword-data: SEO and keyword data from https://keywords.duoleads.com,
paid per call over x402 (USDC on Base): 44 routes, $0.012 to $0.25 per call. The keyword client of duo-data-utilities, published on its own.

`Client` is `KeywordsClient`. The code is generated from the duo-data-utilities sources
(https://github.com/hiesem/duo-data-utilities); this package does not depend on it.
"""

from ._version import USER_AGENT, __version__
from .errors import DuoApiError, PriceGuardError
from .keywords import (
    DEFAULT_KEYWORDS_BASE_URL,
    DEFAULT_KEYWORDS_MAX_PRICE_USD,
    KEYWORDS_MAX_ROUTE_PRICE_USD,
    KEYWORDS_MCP_URL,
    KeywordsClient,
    KeywordsPaidResult,
    assert_keywords_path,
    keywords_query,
)
from .keywords_generated import (
    SEO_KEYWORD_ROUTES,
    KeywordsMethods,
    SeoKeywordRouteInfo,
)
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS

Client = KeywordsClient

__all__ = [
    "__version__",
    "assert_keywords_path",
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "Client",
    "DEFAULT_KEYWORDS_BASE_URL",
    "DEFAULT_KEYWORDS_MAX_PRICE_USD",
    "DuoApiError",
    "KEYWORDS_MAX_ROUTE_PRICE_USD",
    "KEYWORDS_MCP_URL",
    "keywords_query",
    "KeywordsClient",
    "KeywordsMethods",
    "KeywordsPaidResult",
    "PriceGuardError",
    "SEO_KEYWORD_ROUTES",
    "SeoKeywordRouteInfo",
    "USER_AGENT",
]
