from __future__ import annotations

import json
import keyword
from pathlib import Path
from typing import Any

import pytest
import requests
from helpers import (
    BASE_USDC,
    PAY_TO,
    Recorded,
    Reply,
    SpySigner,
    challenge_header,
    decode_payment_signature,
    envelope,
    payment_response_header,
)
from duo_data_utilities import ROUTES, DuoApiError, DuoClient, PriceGuardError
from duo_data_utilities.client import _query, normalise_base_url

IBAN_PATH = "/v1/id/iban"
IBAN_PARAMS = {"iban": "NL91 ABNA 0417 1643 00"}
MANIFEST = json.loads((Path(__file__).resolve().parents[2] / "spec" / "manifest.json").read_text(encoding="utf-8"))


def test_pays_the_real_challenge_once_and_returns_data_and_receipt(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)

    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header()})
        return Reply(
            status=200,
            headers={"PAYMENT-RESPONSE": payment_response_header(throwaway_account.address)},
            body=envelope(IBAN_PATH, {"valid": True, "country": "NL", "reason": None}),
        )

    server = mock_server(reply)
    result = DuoClient(signer, base_url=server.base_url).call_with_receipt(IBAN_PATH, IBAN_PARAMS)

    assert result.data == {"valid": True, "country": "NL", "reason": None}
    assert result.meta["price_usd"] == "0.05"
    assert result.receipt is not None
    assert result.receipt.success is True
    assert result.receipt.network == "eip155:8453"
    assert [r.query for r in server.requests] == [{"iban": ["NL91 ABNA 0417 1643 00"]}] * 2
    assert signer.signatures == 1

    signed = decode_payment_signature(server.requests[1].payment_signature or "")
    assert signed["payload"]["authorization"]["from"] == throwaway_account.address
    assert signed["payload"]["authorization"]["to"] == PAY_TO
    assert signed["payload"]["authorization"]["value"] == "50000"
    assert signed["accepted"]["asset"] == BASE_USDC


def test_refuses_a_six_cent_challenge_before_signing(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)

    def amount_60000(challenge: dict[str, Any]) -> None:
        challenge["accepts"][0]["amount"] = "60000"

    server = mock_server(lambda _r: Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(amount_60000)}))
    client = DuoClient(signer, base_url=server.base_url)

    with pytest.raises(PriceGuardError, match=r"above the maximum \$0\.05"):
        client.call(IBAN_PATH, IBAN_PARAMS)
    assert signer.signatures == 0
    assert all(r.payment_signature is None for r in server.requests)


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c["accepts"][0].__setitem__("network", "eip155:84532"),
        lambda c: c["accepts"][0].__setitem__("asset", "0x0000000000000000000000000000000000000001"),
    ],
    ids=["testnet", "other-asset"],
)
def test_refuses_wrong_network_or_asset_without_signing(mock_server: Any, throwaway_account: Any, change: Any) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(lambda _r: Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(change)}))
    with pytest.raises(PriceGuardError):
        DuoClient(signer, base_url=server.base_url).call(IBAN_PATH, IBAN_PARAMS)
    assert signer.signatures == 0


def test_pays_the_affordable_option_when_two_are_offered(mock_server: Any, throwaway_account: Any) -> None:
    def two_options(challenge: dict[str, Any]) -> None:
        cheap = dict(challenge["accepts"][0])
        dear = {**cheap, "amount": "60000"}
        challenge["accepts"] = [dear, cheap]

    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(two_options)})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(throwaway_account.address)}, body=envelope(IBAN_PATH, {}))

    server = mock_server(reply)
    DuoClient(throwaway_account, base_url=server.base_url).call(IBAN_PATH, IBAN_PARAMS)
    signed = decode_payment_signature(server.requests[1].payment_signature or "")
    assert signed["payload"]["authorization"]["value"] == "50000"


def test_honours_a_higher_max_price(mock_server: Any, throwaway_account: Any) -> None:
    def sixty(challenge: dict[str, Any]) -> None:
        challenge["accepts"][0]["amount"] = "60000"

    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(sixty)})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(throwaway_account.address)}, body=envelope(IBAN_PATH, {}))

    server = mock_server(reply)
    DuoClient(throwaway_account, base_url=server.base_url, max_price_usd=0.1).call(IBAN_PATH, IBAN_PARAMS)
    signed = decode_payment_signature(server.requests[1].payment_signature or "")
    assert signed["payload"]["authorization"]["value"] == "60000"


def test_error_envelope_becomes_duo_api_error(mock_server: Any) -> None:
    body = {
        "ok": False,
        "route": "/v1/id/national",
        "version": "1.0.0",
        "error": {"code": "UNSUPPORTED_VALUE", "param": "kind", "message": "kind xyz is not supported for NL", "expected": "bsn"},
        "meta": {"request_id": "01ERRORREQUEST0000000000", "computed_at": "2026-10-09T00:00:00.000Z", "disclaimer": "x"},
    }
    server = mock_server(lambda _r: Reply(status=400, body=body))
    with pytest.raises(DuoApiError) as info:
        DuoClient(session=requests.Session(), base_url=server.base_url).call("/v1/id/national", {"country": "NL", "kind": "xyz", "value": "1"})
    error = info.value
    assert (error.code, error.param, error.expected, error.status) == ("UNSUPPORTED_VALUE", "kind", "bsn", 400)
    assert (error.route, error.request_id) == ("/v1/id/national", "01ERRORREQUEST0000000000")
    assert str(error) == "kind xyz is not supported for NL"


def test_non_envelope_success_is_invalid_response(mock_server: Any) -> None:
    server = mock_server(lambda _r: Reply(status=200, body={"unexpected": True}))
    with pytest.raises(DuoApiError) as info:
        DuoClient(session=requests.Session(), base_url=server.base_url).call(IBAN_PATH, IBAN_PARAMS)
    assert info.value.code == "INVALID_RESPONSE"


def test_session_option_uses_the_given_session_without_paying(mock_server: Any) -> None:
    server = mock_server(lambda _r: Reply(status=200, body=envelope("/v1/code/jwt", {"valid": True})))
    session = requests.Session()
    result = DuoClient(session=session, base_url=server.base_url).call_with_receipt("/v1/code/jwt", {"token": "a.b.c"})
    assert result.data == {"valid": True}
    assert result.receipt is None
    assert server.requests[0].payment_signature is None


def test_needs_exactly_one_of_account_or_session(throwaway_account: Any) -> None:
    with pytest.raises(TypeError):
        DuoClient()
    with pytest.raises(TypeError):
        DuoClient(throwaway_account, session=requests.Session())


def test_refuses_anything_that_is_not_a_route_path_before_any_request(mock_server: Any) -> None:
    server = mock_server(lambda _r: Reply(status=200, body=envelope("/x", {})))
    client = DuoClient(session=requests.Session(), base_url=server.base_url)
    for path in ["/v1/../mcp", "https://evil.example/v1/id/iban", "/healthz"]:
        with pytest.raises(ValueError):
            client.call(path)
    assert server.requests == []


@pytest.mark.parametrize("raw", ["http://api.example.com", "https://api.example.com/?x=1"])
def test_base_url_must_be_https_without_query(raw: str) -> None:
    with pytest.raises(ValueError):
        normalise_base_url(raw)


def test_base_url_allows_localhost_over_http() -> None:
    assert normalise_base_url("http://localhost:8787/") == "http://localhost:8787"
    assert normalise_base_url("https://api.duoleads.com/") == "https://api.duoleads.com"


def test_booleans_and_numbers_are_written_the_way_the_api_reads_them() -> None:
    assert _query({"strict": False, "lat1": 52.3728, "n": 3, "skip": None, "text": "a b"}) == {
        "strict": "false",
        "lat1": "52.3728",
        "n": "3",
        "text": "a b",
    }
    with pytest.raises(TypeError):
        _query({"list": [1, 2]})


def test_every_generated_method_hits_its_route_with_the_manifest_example(mock_server: Any) -> None:
    server = mock_server(lambda r: Reply(status=200, body=envelope(r.path, {})))
    client = DuoClient(session=requests.Session(), base_url=server.base_url)
    examples = {route["path"]: route["example"] for route in MANIFEST["data"]["routes"]}
    assert len(ROUTES) == 33
    for route in ROUTES:
        method = getattr(getattr(client, route["namespace"]), route["method"])
        example = examples[route["path"]]
        method(**{(f"{name}_" if keyword.iskeyword(name) else name): value for name, value in example.items()})
        last = server.requests[-1]
        assert last.path == route["path"]
        assert {k: v[0] for k, v in last.query.items()} == {k: str(v) for k, v in example.items()}
    assert len(server.requests) == 33


def test_from_keyword_parameter_keeps_its_wire_name(mock_server: Any) -> None:
    server = mock_server(lambda r: Reply(status=200, body=envelope(r.path, {})))
    DuoClient(session=requests.Session(), base_url=server.base_url).timezone.dst_transitions(zone="Europe/Amsterdam", from_="2026-01-01")
    assert server.requests[-1].query == {"zone": ["Europe/Amsterdam"], "from": ["2026-01-01"]}
