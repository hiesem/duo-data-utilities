"""The client names itself in a User-Agent. Loopback mock server only."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import requests
from helpers import Recorded, Reply, challenge_header, envelope, payment_response_header

import duo_data_utilities
from duo_data_utilities import USER_AGENT, DuoClient

PYPROJECT = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
# tomllib is 3.11+, and CI also runs 3.10, so the version line is read with a pattern.
PYPROJECT_VERSION = re.search(r'^version = "([^"]+)"$', PYPROJECT, re.MULTILINE).group(1)  # type: ignore[union-attr]
EXPECTED = f"duo-data-utilities-py/{PYPROJECT_VERSION} (+https://github.com/hiesem/duo-data-utilities)"


def ok_reply(request: Recorded) -> Reply:
    return Reply(status=200, body=envelope(request.path, {"valid": True}))


def test_version_comes_from_the_package_metadata() -> None:
    assert duo_data_utilities.__version__ == PYPROJECT_VERSION
    assert USER_AGENT == EXPECTED


def test_sent_with_every_request(mock_server: Any) -> None:
    server = mock_server(ok_reply)
    client = DuoClient(session=requests.Session(), base_url=server.base_url)
    client.iban.validate(iban="NL91ABNA0417164300")
    client.call("/v1/code/hash", {"data": "x", "algo": "sha256"})
    assert [request.user_agent for request in server.requests] == [EXPECTED, EXPECTED]


def test_can_be_replaced_or_extended(mock_server: Any) -> None:
    server = mock_server(ok_reply)
    DuoClient(session=requests.Session(), base_url=server.base_url, user_agent="my-agent/2.0").call("/v1/id/iban", {"iban": "x"})
    DuoClient(session=requests.Session(), base_url=server.base_url, user_agent=f"{USER_AGENT} my-agent/2.0").call("/v1/id/iban", {"iban": "x"})
    assert [request.user_agent for request in server.requests] == ["my-agent/2.0", f"{EXPECTED} my-agent/2.0"]


def test_refuses_line_breaks() -> None:
    with pytest.raises(ValueError):
        DuoClient(session=requests.Session(), user_agent="a\r\nX-Evil: 1")


def test_reaches_the_server_on_the_unpaid_request_and_the_paid_retry(mock_server: Any, throwaway_account: Any) -> None:
    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header()})
        return Reply(
            status=200,
            headers={"PAYMENT-RESPONSE": payment_response_header(throwaway_account.address)},
            body=envelope(request.path, {"valid": True}),
        )

    server = mock_server(reply)
    DuoClient(throwaway_account, base_url=server.base_url).iban.validate(iban="NL91ABNA0417164300")
    assert [request.user_agent for request in server.requests] == [EXPECTED, EXPECTED]
