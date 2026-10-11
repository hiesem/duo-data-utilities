"""Pay-per-call data utilities for AI agents: IBAN, ISIN, VAT/tax ID, GTIN and 29 more (x402, USDC on Base)."""

from ._version import USER_AGENT, __version__
from .client import DuoClient, PaidResult
from .counterparty import CounterpartyCheck, CounterpartyResult
from .errors import DuoApiError, PriceGuardError
from .generated import ROUTES, DuoMethods, RouteInfo
from .price_guard import BASE_NETWORK, BASE_USDC_ADDRESS, DEFAULT_MAX_PRICE_USD

__all__ = [
    "BASE_NETWORK",
    "BASE_USDC_ADDRESS",
    "CounterpartyCheck",
    "CounterpartyResult",
    "DEFAULT_MAX_PRICE_USD",
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
