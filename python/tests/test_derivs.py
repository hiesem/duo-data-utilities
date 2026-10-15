"""The derivs client (https://derivs.duoleads.com) against a loopback mock server. Mocked 402 challenges,
a throwaway account generated at run time: nothing touches the internet and nothing is paid."""

from __future__ import annotations

from typing import Any, Callable

import pytest
import requests
from helpers import (
    BASE_USDC,
    DERIVS_SPEC,
    PAY_TO,
    Recorded,
    Reply,
    SpySigner,
    decode_payment_signature,
    derivs_amount,
    derivs_challenge_header,
    derivs_example,
    payment_response_header,
)

from duo_data_utilities import (
    DEFAULT_DERIVS_MAX_PRICE_USD,
    DERIVS_MCP_URL,
    DERIVS_ROUTES,
    USER_AGENT,
    DerivsClient,
    DuoApiError,
    DuoClient,
    PriceGuardError,
)
from duo_data_utilities.derivs import derivs_query


def derivs_reply(amount_for: Callable[[str], str] = derivs_amount) -> Callable[[Recorded], Reply]:
    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": derivs_challenge_header(request.path, amount_for(request.path))})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(PAY_TO)}, body=derivs_example(request.path))

    return reply


def signed_value(request: Recorded) -> str:
    return decode_payment_signature(request.payment_signature or "")["payload"]["authorization"]["value"]


def test_route_table_matches_the_snapshot_and_prices() -> None:
    assert [r["path"] for r in DERIVS_ROUTES] == [r["path"] for r in DERIVS_SPEC["routes"]]
    assert {r["path"] for r in DERIVS_ROUTES if r["amount"] == "5000"} == {"/v1/funding-arbitrage", "/v1/perp-screener", "/v1/derivatives-snapshot"}
    assert sum(1 for r in DERIVS_ROUTES if r["amount"] == "3000") == 7
    assert all(r["price_usd"] == ("0.005" if r["amount"] == "5000" else "0.003") for r in DERIVS_ROUTES)
    assert DEFAULT_DERIVS_MAX_PRICE_USD == 0.005
    assert DERIVS_MCP_URL == "https://derivs.duoleads.com/mcp"


def test_every_method_maps_to_its_path_and_query(mock_server: Any) -> None:
    server = mock_server(lambda request: Reply(status=200, body=derivs_example(request.path)))
    client = DerivsClient(session=requests.Session(), base_url=server.base_url)
    for route in DERIVS_ROUTES:
        example = next(r["inputExample"] for r in DERIVS_SPEC["routes"] if r["path"] == route["path"])
        data = getattr(client, route["method"])(**example)
        assert data == derivs_example(route["path"])
        assert server.requests[-1].path == route["path"]
        assert {k: v[0] for k, v in server.requests[-1].query.items()} == example
    assert len(server.requests) == 10


def test_pays_the_three_tenths_of_a_cent_challenge_once(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(derivs_reply())
    result = DerivsClient(signer, base_url=server.base_url).call_with_receipt("/v1/funding-rates", {"coin": "BTC"})
    assert result.data == derivs_example("/v1/funding-rates")
    assert result.receipt is not None and result.receipt.success is True
    assert signer.signatures == 1
    signed = decode_payment_signature(server.requests[1].payment_signature or "")
    assert signed["payload"]["authorization"]["to"] == PAY_TO
    assert signed["payload"]["authorization"]["value"] == "3000"
    assert signed["accepted"]["asset"] == BASE_USDC


def test_pays_the_half_cent_snapshot(mock_server: Any, throwaway_account: Any) -> None:
    server = mock_server(derivs_reply())
    snapshot = DerivsClient(SpySigner(throwaway_account), base_url=server.base_url).derivatives_snapshot(coin="ETH")
    assert snapshot["coin"] == "BTC"  # the mock answers with the recorded BTC example
    assert signed_value(server.requests[1]) == "5000"


def test_refuses_six_tenths_of_a_cent_by_default(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(derivs_reply(lambda _path: "6000"))
    with pytest.raises(PriceGuardError, match=r"above the maximum \$0\.005"):
        DerivsClient(signer, base_url=server.base_url).funding_rates(coin="BTC")
    assert signer.signatures == 0
    assert all(r.payment_signature is None for r in server.requests)


def test_a_three_tenths_cap_refuses_the_half_cent_routes(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(derivs_reply())
    client = DerivsClient(signer, base_url=server.base_url, max_price_usd=0.003)
    client.open_interest(coin="BTC")
    with pytest.raises(PriceGuardError, match=r"5000 atomic units \(\$0\.005\) is above the maximum \$0\.003"):
        client.funding_arbitrage(min_apr=10)
    assert signer.signatures == 1


@pytest.mark.parametrize(
    "edit",
    [
        lambda c: c["accepts"][0].update(payTo="0x0000000000000000000000000000000000000002"),
        lambda c: c["accepts"][0].update(network="eip155:84532"),
        lambda c: c["accepts"][0].update(asset="0x0000000000000000000000000000000000000001"),
    ],
    ids=["another payee", "a testnet", "a non-USDC asset"],
)
def test_refuses_a_foreign_challenge_without_signing(mock_server: Any, throwaway_account: Any, edit: Callable[[dict[str, Any]], None]) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(lambda request: Reply(status=402, headers={"PAYMENT-REQUIRED": derivs_challenge_header(request.path, "3000", edit)}))
    with pytest.raises(PriceGuardError):
        DerivsClient(signer, base_url=server.base_url).basis(coin="BTC")
    assert signer.signatures == 0


def test_duo_client_derivs_has_its_own_cap(mock_server: Any, throwaway_account: Any) -> None:
    signer = SpySigner(throwaway_account)
    server = mock_server(derivs_reply(lambda path: "6000" if path == "/v1/orderbook" else derivs_amount(path)))
    client = DuoClient(signer, derivs_base_url=server.base_url)
    # 6000 is refused although the main API's cap is 50000.
    with pytest.raises(PriceGuardError, match=r"above the maximum \$0\.005"):
        client.derivs.orderbook(coin="BTC", size_usd=100000)
    assert signer.signatures == 0
    client.derivs.perp_screener(sort="oi", limit=10)
    assert server.requests[-2].query == {"sort": ["oi"], "limit": ["10"]}
    assert signed_value(server.requests[-1]) == "5000"
    capped = DuoClient(signer, derivs_base_url=server.base_url, derivs_max_price_usd=0.003)
    with pytest.raises(PriceGuardError):
        capped.derivs.perp_screener()
    assert signer.signatures == 1


def test_user_agent_on_both_requests(mock_server: Any, throwaway_account: Any) -> None:
    server = mock_server(derivs_reply())
    DerivsClient(SpySigner(throwaway_account), base_url=server.base_url).liquidations(coin="BTC", hours=4)
    assert [r.user_agent for r in server.requests] == [USER_AGENT, USER_AGENT]


def test_error_body_becomes_duo_api_error(mock_server: Any) -> None:
    body = {"error": {"status": 400, "code": "INVALID_PARAM", "message": "Unknown coin.", "param": "coin", "expected": "a coin symbol, e.g. BTC"}, "request_id": "01KTEST"}
    server = mock_server(lambda _r: Reply(status=400, body=body))
    with pytest.raises(DuoApiError) as info:
        DerivsClient(session=requests.Session(), base_url=server.base_url).funding_rates(coin="??")
    error = info.value
    assert (error.code, error.param, error.expected, error.status, error.route, error.request_id) == (
        "INVALID_PARAM",
        "coin",
        "a coin symbol, e.g. BTC",
        400,
        "/v1/funding-rates",
        "01KTEST",
    )


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (Reply(status=503, body={"error": {"status": 503, "code": "UPSTREAM_UNAVAILABLE", "message": "nothing was charged"}}), "UPSTREAM_UNAVAILABLE"),
        (Reply(status=402), "PAYMENT_REQUIRED"),
        (Reply(status=200, body=["not", "an", "object"]), "INVALID_RESPONSE"),
        (Reply(status=502), "HTTP_502"),
    ],
)
def test_other_failures(mock_server: Any, reply: Reply, code: str) -> None:
    server = mock_server(lambda _r: reply)
    with pytest.raises(DuoApiError) as info:
        DerivsClient(session=requests.Session(), base_url=server.base_url).open_interest(coin="BTC")
    assert info.value.code == code


def test_numbers_are_plain_decimals() -> None:
    assert derivs_query({"min_volume_usd": 1e12, "fee_pct": 1e-7, "limit": 20, "coin": "BTC", "skip": None}) == {
        "min_volume_usd": "1000000000000",
        "fee_pct": "0.0000001",
        "limit": "20",
        "coin": "BTC",
    }
    with pytest.raises(TypeError):
        derivs_query({"limit": float("nan")})
    with pytest.raises(TypeError):
        derivs_query({"coins": ["BTC"]})


@pytest.mark.parametrize("path", ["/mcp", "/v1/id/iban", "/v1/../mcp", "https://evil.example/v1/basis", "/v1/Basis"])
def test_refuses_non_route_paths(path: str) -> None:
    with pytest.raises(ValueError):
        DerivsClient(session=requests.Session()).call(path)


def test_constructor_checks() -> None:
    with pytest.raises(TypeError):
        DerivsClient()
    with pytest.raises(ValueError):
        DerivsClient(session=requests.Session(), base_url="http://derivs.example.com")
    with pytest.raises(ValueError):
        DerivsClient(session=requests.Session(), max_price_usd=0)
