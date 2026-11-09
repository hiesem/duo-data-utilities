"""The standalone per-service packages in python-packages/ (x402-seo-keyword-data, x402-crypto-derivatives-data,
x402-social-media-data): each is importable without duo-data-utilities, ships the same route table and the same
per-route price caps, and names itself in its User-Agent. Loopback mock server only; nothing is paid."""

from __future__ import annotations

import importlib
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import requests
from helpers import PAY_TO, Recorded, Reply, SpySigner, decode_payment_signature, payment_response_header, service_challenge_header

import duo_data_utilities

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = {
    "x402-seo-keyword-data": ("x402_seo_keyword_data", "KeywordsClient", "SEO_KEYWORD_ROUTES", "/v1/keyword-gap", "POST"),
    "x402-crypto-derivatives-data": ("x402_crypto_derivatives_data", "DerivsClient", "DERIVS_ROUTES", "/v1/funding-rates", "GET"),
    "x402-social-media-data": ("x402_social_media_data", "SocialClient", "SOCIAL_ROUTES", "/v1/x/search", "GET"),
}


def load(dist: str) -> Any:
    path = str(ROOT / "python-packages" / dist)
    if path not in sys.path:
        sys.path.insert(0, path)
    return importlib.import_module(PACKAGES[dist][0])


def version_of(dist: str) -> str:
    text = (ROOT / "python-packages" / dist / "pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'^version = "([^"]+)"$', text, re.MULTILINE).group(1)  # type: ignore[union-attr]


@pytest.mark.parametrize("dist", PACKAGES)
def test_metadata(dist: str) -> None:
    text = (ROOT / "python-packages" / dist / "pyproject.toml").read_text(encoding="utf-8")
    assert f'name = "{dist}"' in text
    assert version_of(dist) == duo_data_utilities.__version__ or duo_data_utilities.__version__ == "0.0.0+unknown"
    assert f'Repository = "https://github.com/hiesem/{dist}"' in text
    assert re.search(r'^Homepage = "https://[a-z]+\.duoleads\.com"$', text, re.MULTILINE)
    assert '"x402[requests,evm]>=2.25.0,<3"' in text
    assert "duo-data-utilities" not in text  # standalone, as the npm packages


@pytest.mark.parametrize("dist", PACKAGES)
def test_exports_the_same_route_table_and_client(dist: str) -> None:
    module = load(dist)
    _, client_name, routes_name, _, _ = PACKAGES[dist]
    assert getattr(module, routes_name) == getattr(duo_data_utilities, routes_name)
    assert module.Client is getattr(module, client_name)
    assert module.Client is not getattr(duo_data_utilities, client_name)
    assert {"DuoApiError", "PriceGuardError", "BASE_NETWORK", "BASE_USDC_ADDRESS", "USER_AGENT", "__version__"} <= set(module.__all__)
    for name in module.__all__:
        assert hasattr(module, name), name


@pytest.mark.parametrize("dist", PACKAGES)
def test_imports_without_the_umbrella_package(dist: str) -> None:
    code = (
        "import sys; sys.modules['duo_data_utilities'] = None\n"
        f"import {PACKAGES[dist][0]} as m\n"
        f"assert all(not k.startswith('duo_data_utilities.') for k in sys.modules)\n"
        "print(m.USER_AGENT)"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "python-packages" / dist, capture_output=True, text=True, check=True)
    assert re.fullmatch(rf"{re.escape(dist)}-py/\S+ \(\+https://github\.com/hiesem/duo-data-utilities\)\n", out.stdout)


@pytest.mark.parametrize("dist", PACKAGES)
def test_pays_its_route_at_the_listed_price_and_refuses_one_unit_more(dist: str, mock_server: Any, throwaway_account: Any) -> None:
    module = load(dist)
    _, client_name, routes_name, path, method = PACKAGES[dist]
    amount = int(next(r["amount"] for r in getattr(module, routes_name) if r["path"] == path))
    offered = {"amount": amount}

    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": service_challenge_header(f"https://example.invalid{request.path}", offered["amount"])})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(PAY_TO)}, body={"ok": 1})

    server = mock_server(reply)
    signer = SpySigner(throwaway_account)
    client = getattr(module, client_name)(signer, base_url=server.base_url)
    params = {"domain": "example.com", "competitor": "example.org"} if method == "POST" else {"coin": "BTC"} if "derivs" in dist else {"q": "x402"}
    assert client.call(path, params) == {"ok": 1}
    assert [r.method for r in server.requests] == [method, method]
    assert decode_payment_signature(server.requests[1].payment_signature or "")["payload"]["authorization"]["value"] == str(amount)
    assert server.requests[0].user_agent == module.USER_AGENT and module.USER_AGENT.startswith(f"{dist}-py/")
    offered["amount"] = amount + 1
    with pytest.raises(module.PriceGuardError):
        client.call(path, params)
    assert signer.signatures == 1


@pytest.mark.parametrize("dist", PACKAGES)
def test_errors_are_the_package_own_classes(dist: str, mock_server: Any) -> None:
    module = load(dist)
    _, client_name, _, path, _ = PACKAGES[dist]
    server = mock_server(lambda _request: Reply(status=400, body={"error": {"code": "INVALID_PARAM", "message": "bad", "param": "q"}}))
    with pytest.raises(module.DuoApiError) as caught:
        getattr(module, client_name)(session=requests.Session(), base_url=server.base_url).call(path, {})
    assert (caught.value.code, caught.value.param) == ("INVALID_PARAM", "q")


# Vendor names are assembled from fragments so this file does not carry them.
FORBIDDEN = [
    re.compile("data" + "for" + "seo", re.IGNORECASE),
    re.compile("scrape" + "creators", re.IGNORECASE),
    re.compile("twitter" + r"api\.io", re.IGNORECASE),
    re.compile("g" + "mail", re.IGNORECASE),
    re.compile(r"\bkvk\b", re.IGNORECASE),
]


def test_no_vendor_names_or_personal_contact_in_the_python_packages() -> None:
    roots = [ROOT / "python" / "duo_data_utilities", ROOT / "python" / "README.md", ROOT / "python" / "pyproject.toml", ROOT / "python-packages"]
    files = [f for r in roots for f in ([r] if r.is_file() else r.rglob("*")) if f.is_file() and "__pycache__" not in f.parts and ".egg-info" not in str(f)]
    assert len(files) > 30
    for f in files:
        text = f.read_text(encoding="utf-8")
        for pattern in FORBIDDEN:
            assert not pattern.search(text), f"{f.relative_to(ROOT)}: {pattern.pattern}"
        for email in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", text):
            assert email == "hello@duoleads.com" or email.endswith("@users.noreply.github.com"), f"{f.relative_to(ROOT)}: {email}"
