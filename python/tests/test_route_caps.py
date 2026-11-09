"""R64-PA-01: by default every derivs route is capped at its own listed price, and every main route at $0.05: the
listed price is signed, the listed price + 1 atomic unit is refused before anything is signed. An explicit
max_price_usd (derivs_max_price_usd on DuoClient) stays the override.

Independent authority for the prices: the committed production snapshots spec/derivs-openapi.json
(x-payment-info) and spec/manifest.json, not the generated route tables under test. Loopback mock server and a
throwaway account generated at run time: nothing touches the internet and nothing is paid."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from decimal import Decimal
from typing import Any

import pytest
from helpers import (
    PAY_TO,
    SPEC,
    Recorded,
    Reply,
    SpySigner,
    challenge_header,
    decode_payment_signature,
    envelope,
    payment_response_header,
)

from duo_data_utilities import DerivsClient, DuoClient, PriceGuardError


def atomic(usd: str) -> int:
    assert re.fullmatch(r"\d+(\.\d{1,6})?", usd), usd
    return int(Decimal(usd) * 1_000_000)


def _derivs_listed() -> list[tuple[str, int]]:
    paths = json.loads((SPEC / "derivs-openapi.json").read_text(encoding="utf-8"))["paths"]
    return [(path, atomic(op["x-payment-info"]["price"]["amount"])) for path, ops in paths.items() for op in ops.values()]


def _main_listed() -> list[tuple[str, int]]:
    data = json.loads((SPEC / "manifest.json").read_text(encoding="utf-8"))["data"]
    return [(r["path"], atomic(r.get("price_usd", data["price_usd"]))) for r in data["routes"]]


DERIVS_LISTED = _derivs_listed()
MAIN_LISTED = _main_listed()


def offering(amounts: dict[str, int]) -> Callable[[Recorded], Reply]:
    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:

            def edit(challenge: dict[str, Any]) -> None:
                challenge["accepts"][0]["amount"] = str(amounts[request.path])
                challenge["resource"] = {"url": f"https://example.invalid{request.path}", "mimeType": "application/json"}
                challenge.pop("extensions", None)

            return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(edit)})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(PAY_TO)}, body=envelope(request.path, {"x": 1}))

    return reply


def assert_per_route_caps(server: Any, amounts: dict[str, int], call: Callable[[str], Any], signer: SpySigner, listed: list[tuple[str, int]]) -> None:
    for path, amount in listed:
        amounts[path] = amount
        before = len(server.requests)
        call(path)
        paid = [r for r in server.requests[before:] if r.payment_signature is not None]
        assert len(paid) == 1, path
        assert decode_payment_signature(paid[0].payment_signature or "")["payload"]["authorization"]["value"] == str(amount), path

        amounts[path] = amount + 1
        signatures = signer.signatures
        before = len(server.requests)
        with pytest.raises(PriceGuardError):
            call(path)
        assert signer.signatures == signatures, f"{path} signed at listed + 1"
        assert all(r.payment_signature is None for r in server.requests[before:]), path


def test_the_snapshots_list_10_derivs_and_33_main_routes() -> None:
    assert len(DERIVS_LISTED) == 10
    assert {a for _, a in DERIVS_LISTED} == {3000, 5000}
    assert len(MAIN_LISTED) == 33


def test_derivs_client_caps_every_route_at_its_own_price(mock_server: Any, throwaway_account: Any) -> None:
    amounts: dict[str, int] = {}
    server = mock_server(offering(amounts))
    signer = SpySigner(throwaway_account)
    client = DerivsClient(signer, base_url=server.base_url)
    assert_per_route_caps(server, amounts, client.call, signer, DERIVS_LISTED)


def test_duo_client_derivs_caps_every_route_at_its_own_price(mock_server: Any, throwaway_account: Any) -> None:
    amounts: dict[str, int] = {}
    server = mock_server(offering(amounts))
    signer = SpySigner(throwaway_account)
    client = DuoClient(signer, derivs_base_url=server.base_url)
    assert_per_route_caps(server, amounts, client.derivs.call, signer, DERIVS_LISTED)


def test_duo_client_caps_every_main_route_at_its_price(mock_server: Any, throwaway_account: Any) -> None:
    amounts: dict[str, int] = {}
    server = mock_server(offering(amounts))
    signer = SpySigner(throwaway_account)
    client = DuoClient(signer, base_url=server.base_url)
    assert_per_route_caps(server, amounts, client.call, signer, MAIN_LISTED)


@pytest.mark.parametrize(
    ("path", "cap", "amount", "pays"),
    [
        ("/v1/funding-rates", 0.005, 5000, True),
        ("/v1/funding-rates", 0.003, 3001, False),
        ("/v1/derivatives-snapshot", 0.003, 5000, False),
        ("/v1/derivatives-snapshot", 0.006, 6000, True),
    ],
)
def test_an_explicit_cap_overrides_the_per_route_default(mock_server: Any, throwaway_account: Any, path: str, cap: float, amount: int, pays: bool) -> None:
    server = mock_server(offering({path: amount}))
    for make in (
        lambda s: DerivsClient(s, base_url=server.base_url, max_price_usd=cap),
        lambda s: DuoClient(s, derivs_base_url=server.base_url, derivs_max_price_usd=cap).derivs,
    ):
        signer = SpySigner(throwaway_account)
        if pays:
            make(signer).call(path)
        else:
            with pytest.raises(PriceGuardError):
                make(signer).call(path)
        assert signer.signatures == (1 if pays else 0)


def test_an_unknown_derivs_path_keeps_the_half_cent_default(mock_server: Any, throwaway_account: Any) -> None:
    server = mock_server(offering({"/v1/not-listed": 5001}))
    signer = SpySigner(throwaway_account)
    with pytest.raises(PriceGuardError, match=r"above the maximum \$0\.005"):
        DerivsClient(signer, base_url=server.base_url).call("/v1/not-listed")
    assert signer.signatures == 0
