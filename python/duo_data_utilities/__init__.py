"""Pay-per-call data for AI agents (x402, USDC on Base): IBAN, ISIN, VAT/tax ID, GTIN and 29 more utilities, plus
crypto derivatives data (perp funding rates, open interest, futures basis, implied volatility, liquidations,
order book depth) through DuoClient(...).derivs or DerivsClient."""

from ._version import USER_AGENT, __version__
from .client import DuoClient, PaidResult
from .counterparty import CounterpartyCheck, CounterpartyResult
from .derivs import DEFAULT_DERIVS_BASE_URL, DEFAULT_DERIVS_MAX_PRICE_USD, DERIVS_MCP_URL, DerivsClient, DerivsPaidResult
from .derivs_generated import DERIVS_ROUTES, DerivsMethods, DerivsRouteInfo
from .errors import DuoApiError, PriceGuardError
from .generated import ROUTES, DuoMethods, RouteInfo
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS, DEFAULT_MAX_PRICE_USD

__all__ = [
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "CounterpartyCheck",
    "CounterpartyResult",
    "DEFAULT_DERIVS_BASE_URL",
    "DEFAULT_DERIVS_MAX_PRICE_USD",
    "DEFAULT_MAX_PRICE_USD",
    "DERIVS_MCP_URL",
    "DERIVS_ROUTES",
    "DerivsClient",
    "DerivsMethods",
    "DerivsPaidResult",
    "DerivsRouteInfo",
    "DuoApiError",
    "DuoClient",
    "DuoMethods",
    "PaidResult",
    "PriceGuardError",
    "ROUTES",
    "RouteInfo",
    "USER_AGENT",
    "__version__",
]
