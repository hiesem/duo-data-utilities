from __future__ import annotations

import pytest
from helpers import BASE_USDC, PAY_TO, fixture_challenge
from duo_data_utilities.errors import PriceGuardError
from duo_data_utilities.price_guard import format_usd, guard_policy, requirement_problem, usd_to_atomic
from x402.schemas import PaymentRequirements


def requirement(**changes: object) -> PaymentRequirements:
    base = fixture_challenge()["accepts"][0]
    return PaymentRequirements.model_validate({**base, **changes})


def test_converts_usd_to_atomic_units() -> None:
    assert usd_to_atomic(0.05) == 50000
    assert usd_to_atomic(1) == 1000000


@pytest.mark.parametrize("value", [0, -0.05, float("nan"), 1e-9])
def test_rejects_amounts_that_are_not_positive_or_representable(value: float) -> None:
    with pytest.raises(ValueError):
        usd_to_atomic(value)


def test_formats_atomic_units_as_dollars() -> None:
    assert format_usd(50000) == "$0.05"
    assert format_usd(60000) == "$0.06"
    assert format_usd(1000000) == "$1.00"
    assert format_usd(1) == "$0.000001"


def test_accepts_the_real_five_cent_requirement() -> None:
    real = requirement()
    assert real.amount == "50000"
    assert real.asset == BASE_USDC
    assert real.pay_to == PAY_TO
    assert requirement_problem(real, 50000) is None


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"amount": "60000"}, "above the maximum \\$0.05"),
        ({"amount": "0"}, "amount is zero"),
        ({"amount": "0.05"}, "not an integer in atomic USDC units"),
        ({"network": "eip155:84532"}, "is not eip155:8453 \\(Base\\)"),
        ({"asset": "0x0000000000000000000000000000000000000001"}, "is not Base USDC"),
        ({"scheme": "upto"}, "is not \"exact\""),
        ({"payTo": "0x0000000000000000000000000000000000000002"}, "is not the expected payee"),
    ],
)
def test_refuses_requirements_outside_the_guard(changes: dict[str, object], message: str) -> None:
    import re

    problem = requirement_problem(requirement(**changes), 50000)
    assert problem is not None
    assert re.search(message, problem)


def test_policy_keeps_only_acceptable_requirements() -> None:
    cheap = requirement()
    dear = requirement(amount="60000")
    assert guard_policy(50000, 0.05)(2, [dear, cheap]) == [cheap]


def test_policy_refuses_when_nothing_is_acceptable() -> None:
    with pytest.raises(PriceGuardError) as info:
        guard_policy(50000, 0.05)(2, [requirement(amount="60000")])
    assert "above the maximum $0.05" in str(info.value)
    assert info.value.max_price_usd == 0.05


def test_any_payee_only_when_pay_to_is_none() -> None:
    other = requirement(payTo="0x0000000000000000000000000000000000000002")
    assert requirement_problem(other, 50000, None) is None
    assert requirement_problem(other, 50000, "0x0000000000000000000000000000000000000002") is None


def test_rounds_the_cap_down() -> None:
    assert usd_to_atomic(0.0499996) == 49999
    assert usd_to_atomic(0.57) == 570000
    assert usd_to_atomic(0.05) == 50000
