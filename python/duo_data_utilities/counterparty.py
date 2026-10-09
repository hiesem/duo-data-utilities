"""Counterparty check: IBAN, tax ID and country in one verdict. Mirrors src/counterparty.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import DuoApiError

Status = Literal["pass", "fail", "review"]

INPUT_PROBLEM_CODES = frozenset({"MISSING_PARAM", "INVALID_PARAM", "INPUT_TOO_LARGE"})
NOT_COVERED_CODES = frozenset({"UNSUPPORTED_VALUE"})


@dataclass(frozen=True)
class CounterpartyCheck:
    """One check. `check` is one of iban, tax_id, country or country_match (no route for the last)."""

    check: str
    route: str | None
    status: Status
    detail: str


@dataclass(frozen=True)
class CounterpartyResult:
    """`verdict` is fail if any check failed, else review if any check could not run or the countries differ, else pass."""

    verdict: Status
    checks: list[CounterpartyCheck] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise TypeError(f"{name} must be a non-empty string")
    return value.strip()


def _country(value: Any) -> str:
    code = _text(value, "country").upper()
    if not re.fullmatch(r"[A-Z]{2}", code):
        raise ValueError("country must be an ISO 3166-1 alpha-2 code, e.g. NL")
    return "GB" if code == "UK" else code


def _problem_check(check: str, route: str, problem: DuoApiError) -> CounterpartyCheck:
    status: Status = "review" if problem.code in NOT_COVERED_CODES else "fail"
    return CounterpartyCheck(check=check, route=route, status=status, detail=f"{problem.message} ({problem.code})")


def run_counterparty_check(api: Any, *, iban: str, country: str, tax_id_type: str, tax_id: str) -> CounterpartyResult:
    """Runs the three checks in order (three calls, $0.15) and combines them. Inputs are validated before any call."""
    iban = _text(iban, "iban")
    country = _country(country)
    tax_id_type = _text(tax_id_type, "tax_id_type")
    tax_id = _text(tax_id, "tax_id")
    checks: list[CounterpartyCheck] = []

    iban_route = "/v1/id/iban"
    iban_country: str | None = None
    try:
        iban_data = api.iban.validate(iban=iban)
    except DuoApiError as problem:
        if problem.code not in INPUT_PROBLEM_CODES | NOT_COVERED_CODES:
            raise
        checks.append(_problem_check("iban", iban_route, problem))
    else:
        if iban_data["valid"]:
            iban_country = str(iban_data["country"]).upper()
            checks.append(CounterpartyCheck("iban", iban_route, "pass", f"IBAN checksum valid ({iban_country})"))
        else:
            checks.append(CounterpartyCheck("iban", iban_route, "fail", f"IBAN invalid: {iban_data.get('reason') or 'unknown reason'}"))

    tax_route = "/v1/id/national"
    try:
        tax_data = api.tax_id.validate(country=country, kind=tax_id_type, value=tax_id)
    except DuoApiError as problem:
        if problem.code not in INPUT_PROBLEM_CODES | NOT_COVERED_CODES:
            raise
        checks.append(_problem_check("tax_id", tax_route, problem))
    else:
        if tax_data["valid"]:
            checks.append(CounterpartyCheck("tax_id", tax_route, "pass", f"{tax_id_type} checksum valid for {country}"))
        else:
            checks.append(
                CounterpartyCheck("tax_id", tax_route, "fail", f"{tax_id_type} invalid for {country}: {tax_data.get('reason') or 'unknown reason'}")
            )

    country_route = "/v1/ref/country"
    try:
        country_data = api.country.lookup(code=country)
    except DuoApiError as problem:
        if problem.code not in INPUT_PROBLEM_CODES | NOT_COVERED_CODES:
            raise
        checks.append(_problem_check("country", country_route, problem))
    else:
        if country_data["found"] and country_data.get("kind") == "country":
            checks.append(CounterpartyCheck("country", country_route, "pass", f"{country} is an ISO 3166-1 country"))
        else:
            checks.append(CounterpartyCheck("country", country_route, "fail", f"{country} is not an ISO 3166-1 country code"))

    if iban_country is not None and iban_country != country:
        checks.append(
            CounterpartyCheck(
                "country_match",
                None,
                "review",
                f"IBAN country {iban_country} differs from the tax ID country {country}",
            )
        )

    statuses = [check.status for check in checks]
    verdict: Status = "fail" if "fail" in statuses else "review" if "review" in statuses else "pass"
    reasons = [check.detail for check in checks if check.status != "pass"]
    return CounterpartyResult(verdict=verdict, checks=checks, reasons=reasons)
