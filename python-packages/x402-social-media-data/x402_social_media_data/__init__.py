"""x402-social-media-data: Social media data from https://social.duoleads.com,
paid per call over x402 (USDC on Base): 26 routes, $0.01 to $0.025 per call. The social client of duo-data-utilities, published on its own.

`Client` is `SocialClient`. The code is generated from the duo-data-utilities sources
(https://github.com/hiesem/duo-data-utilities); this package does not depend on it.
"""

from ._version import USER_AGENT, __version__
from .errors import DuoApiError, PriceGuardError
from .social import (
    DEFAULT_SOCIAL_BASE_URL,
    DEFAULT_SOCIAL_MAX_PRICE_USD,
    SOCIAL_MCP_URL,
    SocialClient,
    SocialPaidResult,
    assert_social_path,
    social_query,
)
from .social_generated import (
    SOCIAL_ROUTES,
    SocialMethods,
    SocialRouteInfo,
)
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS

Client = SocialClient

__all__ = [
    "__version__",
    "assert_social_path",
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "Client",
    "DEFAULT_SOCIAL_BASE_URL",
    "DEFAULT_SOCIAL_MAX_PRICE_USD",
    "DuoApiError",
    "PriceGuardError",
    "SOCIAL_MCP_URL",
    "social_query",
    "SOCIAL_ROUTES",
    "SocialClient",
    "SocialMethods",
    "SocialPaidResult",
    "SocialRouteInfo",
    "USER_AGENT",
]
