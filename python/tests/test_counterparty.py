from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import requests
from helpers import Recorded, Reply, envelope
from duo_data_utilities import DuoApiError, DuoClient

ROOT = Path(__file__).resolve().parents[2]
IBAN_OK = {"valid": True, "country": "NL", "reason": None}
TAX_OK = {"valid": True, "country": "NL", "kind": "bsn", "reason": None}
COUNTRY_OK = {"found": True, "kind": "country", "alpha_2": "NL"}
INPUT = {"iban": "NL91 ABNA 0417 1643 00", "country": "NL", "tax_id_type": "bsn", "tax_id": "111222333"}


def answering(mock_server: Any, routes: dict[str, Any]) -> Any:
    """A mock server that answers each route from a table: a dict is data, a tuple is (code, message)."""

    def reply(request: Recorded) -> Reply:
        answer = routes[request.path]
        if isinstance(answer, tuple):
            code, message = answer
            return Reply(
                status=400,
                body={
                    "ok": False,
                    "route": request.path,
                    "version": "1.0.0",
                    "error": {"code": code, "message": message, "param": None, "expected": None},
                    "meta": {"request_id": "01COUNTERPARTY0000000000", "computed_at": "2026-10-09T00:00:00.000Z", "disclaimer": "x"},
                },
            )
        return Reply(status=200, body=envelope(request.path, answer))

    return mock_server(reply)


def test_passes_when_every_check_passes_with_three_calls(mock_server: Any) -> None:
    server = answering(mock_server, {"/v1/id/iban": IBAN_OK, "/v1/id/national": TAX_OK, "/v1/ref/country": COUNTRY_OK})
    result = DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**INPUT)
    assert result.verdict == "pass"
    assert result.reasons == []
    assert [(c.check, c.route, c.status) for c in result.checks] == [
        ("iban", "/v1/id/iban", "pass"),
        ("tax_id", "/v1/id/national", "pass"),
        ("country", "/v1/ref/country", "pass"),
    ]
    assert [r.path for r in server.requests] == ["/v1/id/iban", "/v1/id/national", "/v1/ref/country"]
    assert server.requests[1].query == {"country": ["NL"], "kind": ["bsn"], "value": ["111222333"]}


def test_fails_on_an_invalid_iban_and_still_checks_the_rest(mock_server: Any) -> None:
    server = answering(
        mock_server,
        {"/v1/id/iban": {"valid": False, "country": "NL", "reason": "checksum"}, "/v1/id/national": TAX_OK, "/v1/ref/country": COUNTRY_OK},
    )
    result = DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**INPUT)
    assert result.verdict == "fail"
    assert result.reasons == ["IBAN invalid: checksum"]
    assert len(server.requests) == 3


def test_reviews_when_the_iban_country_differs(mock_server: Any) -> None:
    server = answering(
        mock_server,
        {"/v1/id/iban": {"valid": True, "country": "DE", "reason": None}, "/v1/id/national": TAX_OK, "/v1/ref/country": COUNTRY_OK},
    )
    result = DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**INPUT)
    assert result.verdict == "review"
    assert result.checks[-1].check == "country_match"
    assert result.reasons == ["IBAN country DE differs from the tax ID country NL"]


def test_reads_uk_as_gb(mock_server: Any) -> None:
    server = answering(
        mock_server,
        {
            "/v1/id/iban": {"valid": True, "country": "GB", "reason": None},
            "/v1/id/national": {"valid": True, "country": "GB", "kind": "nino", "reason": None},
            "/v1/ref/country": {"found": True, "kind": "country", "alpha_2": "GB"},
        },
    )
    result = DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**{**INPUT, "country": "uk", "tax_id_type": "nino"})
    assert result.verdict == "pass"
    assert server.requests[1].query["country"] == ["GB"]


def test_reviews_when_the_api_does_not_cover_the_kind(mock_server: Any) -> None:
    server = answering(
        mock_server,
        {
            "/v1/id/iban": IBAN_OK,
            "/v1/id/national": ("UNSUPPORTED_VALUE", "kind xyz is not supported for NL"),
            "/v1/ref/country": COUNTRY_OK,
        },
    )
    result = DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**{**INPUT, "tax_id_type": "xyz"})
    assert result.verdict == "review"
    assert result.checks[1].status == "review"
    assert result.checks[1].detail == "kind xyz is not supported for NL (UNSUPPORTED_VALUE)"


def test_rethrows_errors_that_are_not_about_the_input(mock_server: Any) -> None:
    server = answering(
        mock_server,
        {"/v1/id/iban": IBAN_OK, "/v1/id/national": ("INTERNAL", "something broke"), "/v1/ref/country": COUNTRY_OK},
    )
    with pytest.raises(DuoApiError) as info:
        DuoClient(session=requests.Session(), base_url=server.base_url).check_counterparty(**INPUT)
    assert info.value.code == "INTERNAL"


@pytest.mark.parametrize(
    "change",
    [{"country": "NLD"}, {"iban": "   "}, {"tax_id_type": ""}],
    ids=["three-letter-country", "blank-iban", "empty-kind"],
)
def test_refuses_bad_input_before_any_call(mock_server: Any, change: dict[str, str]) -> None:
    server = answering(mock_server, {})
    client = DuoClient(session=requests.Session(), base_url=server.base_url)
    with pytest.raises((TypeError, ValueError)):
        client.check_counterparty(**{**INPUT, **change})
    assert server.requests == []


def test_generated_module_is_up_to_date() -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "python" / "scripts" / "generate.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
