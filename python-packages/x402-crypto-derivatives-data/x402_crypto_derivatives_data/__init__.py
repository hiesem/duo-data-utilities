"""x402-crypto-derivatives-data: Crypto derivatives data from https://derivs.duoleads.com,
paid per call over x402 (USDC on Base): 10 routes, $0.003 or $0.005 per call. The derivs client of duo-data-utilities, published on its own.

`Client` is `DerivsClient`. The code is generated from the duo-data-utilities sources
(https://github.com/hiesem/duo-data-utilities); this package does not depend on it.
"""

from ._version import USER_AGENT, __version__
from .errors import DuoApiError, PriceGuardError
from .derivs import (
    DEFAULT_DERIVS_BASE_URL,
    DEFAULT_DERIVS_MAX_PRICE_USD,
    DERIVS_MCP_URL,
    DerivsClient,
    DerivsPaidResult,
    assert_derivs_path,
    derivs_query,
)
from .derivs_generated import (
    DERIVS_ROUTES,
    DerivsMethods,
    DerivsRouteInfo,
)
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS

Client = DerivsClient

__all__ = [
    "__version__",
    "assert_derivs_path",
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "Client",
    "DEFAULT_DERIVS_BASE_URL",
    "DEFAULT_DERIVS_MAX_PRICE_USD",
    "DERIVS_MCP_URL",
    "derivs_query",
    "DERIVS_ROUTES",
    "DerivsClient",
    "DerivsMethods",
    "DerivsPaidResult",
    "DerivsRouteInfo",
    "DuoApiError",
    "PriceGuardError",
    "USER_AGENT",
]
