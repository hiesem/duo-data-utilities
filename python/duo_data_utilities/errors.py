from __future__ import annotations

from typing import Any


class DuoApiError(Exception):
    """The API answered with an error envelope, or with a response that is not a valid envelope."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        status: int,
        route: str,
        param: str | None = None,
        expected: str | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.route = route
        self.param = param
        self.expected = expected
        self.request_id = request_id


class PriceGuardError(Exception):
    """The price guard refused a payment requirement before anything was signed. No payment was made."""

    def __init__(self, reasons: list[str], max_price_usd: float) -> None:
        self.reasons = list(reasons) or ["the challenge offers no payment option"]
        self.max_price_usd = max_price_usd
        super().__init__(
            f"Refused to pay: {'; '.join(self.reasons)}. Nothing was signed (maximum ${max_price_usd} per call)."
        )
