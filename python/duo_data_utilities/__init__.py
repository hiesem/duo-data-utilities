"""Pay-per-call data for AI agents (x402, USDC on Base), one Python client for four services:

- DuoClient: IBAN, ISIN, VAT/tax ID, GTIN and 29 more utilities (https://api.duoleads.com, $0.05 per call);
- DerivsClient (also DuoClient(...).derivs): crypto derivatives data, perp funding rates, open interest, futures
  basis, implied volatility, liquidations, order book depth (https://derivs.duoleads.com, $0.003 or $0.005);
- KeywordsClient (also DuoClient(...).keywords): SEO and keyword data, search volume, CPC, keyword difficulty,
  Google Trends, SERP results, backlinks (https://keywords.duoleads.com, $0.012 to $0.25);
- SocialClient (also DuoClient(...).social): social media data, public posts, profiles, comments and search on X,
  Reddit, TikTok, Instagram, YouTube, LinkedIn, Bluesky and Hacker News (https://social.duoleads.com, $0.01 to
  $0.025).
"""

from ._version import USER_AGENT, __version__
from .client import DuoClient, PaidResult
from .counterparty import CounterpartyCheck, CounterpartyResult
from .derivs import DEFAULT_DERIVS_BASE_URL, DEFAULT_DERIVS_MAX_PRICE_USD, DERIVS_MCP_URL, DerivsClient, DerivsPaidResult
from .derivs_generated import DERIVS_ROUTES, DerivsMethods, DerivsRouteInfo
from .errors import DuoApiError, PriceGuardError
from .generated import ROUTES, DuoMethods, RouteInfo
from .keywords import (
    DEFAULT_KEYWORDS_BASE_URL,
    DEFAULT_KEYWORDS_MAX_PRICE_USD,
    KEYWORDS_MAX_ROUTE_PRICE_USD,
    KEYWORDS_MCP_URL,
    KeywordsClient,
    KeywordsPaidResult,
)
from .keywords_generated import SEO_KEYWORD_ROUTES, KeywordsMethods, SeoKeywordRouteInfo
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS, DEFAULT_MAX_PRICE_USD
from .social import DEFAULT_SOCIAL_BASE_URL, DEFAULT_SOCIAL_MAX_PRICE_USD, SOCIAL_MCP_URL, SocialClient, SocialPaidResult
from .social_generated import SOCIAL_ROUTES, SocialMethods, SocialRouteInfo

__all__ = [
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "CounterpartyCheck",
    "CounterpartyResult",
    "DEFAULT_DERIVS_BASE_URL",
    "DEFAULT_DERIVS_MAX_PRICE_USD",
    "DEFAULT_KEYWORDS_BASE_URL",
    "DEFAULT_KEYWORDS_MAX_PRICE_USD",
    "DEFAULT_MAX_PRICE_USD",
    "DEFAULT_SOCIAL_BASE_URL",
    "DEFAULT_SOCIAL_MAX_PRICE_USD",
    "DERIVS_MCP_URL",
    "DERIVS_ROUTES",
    "DerivsClient",
    "DerivsMethods",
    "DerivsPaidResult",
    "DerivsRouteInfo",
    "DuoApiError",
    "DuoClient",
    "DuoMethods",
    "KEYWORDS_MAX_ROUTE_PRICE_USD",
    "KEYWORDS_MCP_URL",
    "KeywordsClient",
    "KeywordsMethods",
    "KeywordsPaidResult",
    "PaidResult",
    "PriceGuardError",
    "ROUTES",
    "RouteInfo",
    "SEO_KEYWORD_ROUTES",
    "SOCIAL_MCP_URL",
    "SOCIAL_ROUTES",
    "SeoKeywordRouteInfo",
    "SocialClient",
    "SocialMethods",
    "SocialPaidResult",
    "SocialRouteInfo",
    "USER_AGENT",
    "__version__",
]
