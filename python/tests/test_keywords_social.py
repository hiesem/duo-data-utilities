"""The keyword (https://keywords.duoleads.com) and social (https://social.duoleads.com) clients against a loopback
mock server, with mocked 402 challenges and a throwaway account generated at run time: nothing touches the internet
and nothing is paid.

Independent authorities: the committed OpenAPI snapshots spec/keywords-openapi.json and spec/social-openapi.json
(paths, HTTP methods, MCP tools, prices, request and answer examples) and spec/fixtures/live-402-amounts.json (the
amount of every route's real unpaid 402 challenge), not the generated route tables under test.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from decimal import Decimal
from typing import Any

import pytest
import requests
from helpers import (
    PAY_TO,
    SPEC,
    Recorded,
    Reply,
    SpySigner,
    decode_payment_signature,
    payment_response_header,
    service_challenge_header,
)

from duo_data_utilities import (
    DEFAULT_KEYWORDS_BASE_URL,
    DEFAULT_KEYWORDS_MAX_PRICE_USD,
    DEFAULT_SOCIAL_BASE_URL,
    DEFAULT_SOCIAL_MAX_PRICE_USD,
    KEYWORDS_MAX_ROUTE_PRICE_USD,
    KEYWORDS_MCP_URL,
    SEO_KEYWORD_ROUTES,
    SOCIAL_MCP_URL,
    SOCIAL_ROUTES,
    DuoApiError,
    DuoClient,
    KeywordsClient,
    PriceGuardError,
    SocialClient,
)
from duo_data_utilities.keywords import keywords_query
from duo_data_utilities.social import social_query

KW_SPEC = json.loads((SPEC / "keywords-openapi.json").read_text(encoding="utf-8"))
SOCIAL_SPEC = json.loads((SPEC / "social-openapi.json").read_text(encoding="utf-8"))
LIVE_402 = json.loads((SPEC / "fixtures" / "live-402-amounts.json").read_text(encoding="utf-8"))["routes"]


def atomic(usd: str) -> int:
    assert re.fullmatch(r"\d+(\.\d{1,6})?", usd), usd
    return int(Decimal(usd) * 1_000_000)


def operations(spec: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """(path, HTTP method, operation) for every route of a snapshot."""
    return [(path, method.upper(), op) for path, ops in spec["paths"].items() for method, op in ops.items()]


KW_OPS = operations(KW_SPEC)
SOCIAL_OPS = operations(SOCIAL_SPEC)


def request_example(method: str, op: dict[str, Any]) -> dict[str, Any]:
    if method == "POST":
        return dict(op["requestBody"]["content"]["application/json"]["example"])
    return {p["name"]: p["example"] for p in op.get("parameters", []) if p["in"] == "query" and "example" in p}


def answer_example(op: dict[str, Any]) -> dict[str, Any]:
    return op["responses"]["200"]["content"]["application/json"]["example"]


def by_path(ops: list[tuple[str, str, dict[str, Any]]]) -> dict[str, tuple[str, dict[str, Any]]]:
    return {path: (method, op) for path, method, op in ops}


SERVICES = [
    pytest.param(KeywordsClient, SEO_KEYWORD_ROUTES, KW_OPS, "https://keywords.duoleads.com", id="keywords"),
    pytest.param(SocialClient, SOCIAL_ROUTES, SOCIAL_OPS, "https://social.duoleads.com", id="social"),
]


# ---------------------------------------------------------------- route tables


def test_keyword_route_table_is_complete() -> None:
    assert len(KW_OPS) == 44
    assert [(r["path"], r["http_method"], r["tool"], r["amount"]) for r in SEO_KEYWORD_ROUTES] == [
        (path, method, op["x-mcp-tool"], str(atomic(op["x-payment-info"]["price"]["amount"]))) for path, method, op in KW_OPS
    ]
    # The TypeScript client's method names (scripts/generate.mjs camelPath), in snake_case.
    assert {r["method"] for r in SEO_KEYWORD_ROUTES} >= {"keyword_overview", "search_volume", "keyword_ideas", "trend", "keyword_gap", "on_page", "bing_serp", "llm_mentions"}
    assert sum(r["http_method"] == "GET" for r in SEO_KEYWORD_ROUTES) == 9
    assert max(atomic(r["price_usd"]) for r in SEO_KEYWORD_ROUTES) == atomic(str(KEYWORDS_MAX_ROUTE_PRICE_USD)) == 250000
    assert DEFAULT_KEYWORDS_BASE_URL == "https://keywords.duoleads.com"
    assert DEFAULT_KEYWORDS_MAX_PRICE_USD == 0.045
    assert KEYWORDS_MCP_URL == "https://keywords.duoleads.com/mcp"


def test_social_route_table_is_complete() -> None:
    assert len(SOCIAL_OPS) == 26
    assert [(r["path"], r["http_method"], r["tool"], r["amount"]) for r in SOCIAL_ROUTES] == [
        (path, method, op["x-mcp-tool"], str(atomic(op["x-payment-info"]["price"]["amount"]))) for path, method, op in SOCIAL_OPS
    ]
    assert all(r["http_method"] == "GET" for r in SOCIAL_ROUTES)
    assert {r["method"] for r in SOCIAL_ROUTES} >= {"bluesky_search", "hackernews_thread", "x_search", "social_search", "linkedin_profile"}
    assert DEFAULT_SOCIAL_BASE_URL == "https://social.duoleads.com"
    assert DEFAULT_SOCIAL_MAX_PRICE_USD == 0.025 == max(float(r["price_usd"]) for r in SOCIAL_ROUTES)
    assert SOCIAL_MCP_URL == "https://social.duoleads.com/mcp"


@pytest.mark.parametrize(("_client", "routes", "_ops", "origin"), SERVICES)
def test_prices_match_the_live_402_challenges(_client: Any, routes: Any, _ops: Any, origin: str) -> None:
    for route in routes:
        live = LIVE_402[origin + route["path"]]
        assert (live["method"], live["amount"], live["payTo"]) == (route["http_method"], route["amount"], PAY_TO), route["path"]
    assert len([u for u in LIVE_402 if u.startswith(origin)]) == len(routes)


@pytest.mark.parametrize(("client_class", "routes", "_ops", "_origin"), SERVICES)
def test_every_route_has_a_method_with_its_parameters(client_class: Any, routes: Any, _ops: Any, _origin: str) -> None:
    client = client_class(session=requests.Session())
    for route in routes:
        assert callable(getattr(client, route["method"])), route["method"]


# ---------------------------------------------------------------- requests per route


@pytest.mark.parametrize(("client_class", "routes", "ops", "_origin"), SERVICES)
def test_every_method_sends_its_route_with_the_right_http_method(mock_server: Any, client_class: Any, routes: Any, ops: Any, _origin: str) -> None:
    spec = by_path(ops)
    server = mock_server(lambda request: Reply(status=200, body=answer_example(spec[request.path][1])))
    client = client_class(session=requests.Session(), base_url=server.base_url)
    for route in routes:
        method, op = spec[route["path"]]
        example = request_example(method, op)
        data = getattr(client, route["method"])(**example)
        assert data == answer_example(op), route["path"]
        sent = server.requests[-1]
        assert (sent.method, sent.path) == (method, route["path"])
        if method == "POST":
            assert sent.content_type == "application/json"
            assert sent.json() == example
            assert sent.query == {}
        else:
            assert sent.body is None
            assert {k: v[0] for k, v in sent.query.items()} == {k: str(v) for k, v in example.items()}
    assert len(server.requests) == len(routes)


def test_post_body_drops_none_and_keeps_wire_names(mock_server: Any) -> None:
    server = mock_server(lambda _request: Reply(status=200, body={"total": 0}))
    client = KeywordsClient(session=requests.Session(), base_url=server.base_url)
    client.keyword_overview(keywords=["phone", "watch,strap"], locationCode=2840, includeMonthly=True, country=None)
    sent = server.requests[-1]
    assert (sent.method, sent.path) == ("POST", "/v1/keyword-overview")
    assert sent.json() == {"keywords": ["phone", "watch,strap"], "locationCode": 2840, "includeMonthly": True}
    client.call("/v1/backlinks", {"target": "example.com"})
    assert server.requests[-1].method == "POST" and server.requests[-1].json() == {"target": "example.com"}
    client.call("/v1/whois")
    assert server.requests[-1].json() == {}
    with pytest.raises(TypeError, match="finite"):
        client.keyword_ideas(keyword="x", limit=float("nan"))  # type: ignore[arg-type]
    assert len(server.requests) == 3


def test_get_keywords_list_becomes_a_comma_list(mock_server: Any) -> None:
    server = mock_server(lambda _request: Reply(status=200, body={"total": 2}))
    client = KeywordsClient(session=requests.Session(), base_url=server.base_url)
    client.search_volume(keywords=["phone", "watch"], country="us", includeMonthly=True)
    sent = server.requests[-1]
    assert (sent.method, sent.path, sent.body) == ("GET", "/v1/search-volume", None)
    assert sent.query == {"keywords": ["phone,watch"], "country": ["us"], "includeMonthly": ["true"]}
    with pytest.raises(TypeError, match="without commas"):
        client.search_volume(keywords=["phone", "watch,strap"])
    assert keywords_query({"num": 10, "x": 0.5, "skip": None}) == {"num": "10", "x": "0.5"}


def test_social_query_values(mock_server: Any) -> None:
    server = mock_server(lambda _request: Reply(status=200, body={"posts": []}))
    client = SocialClient(session=requests.Session(), base_url=server.base_url)
    client.bluesky_search(q="x402", limit=10)
    client.linkedin_company(url="https://www.linkedin.com/company/example", posts=True)
    assert [r.query for r in server.requests] == [{"q": ["x402"], "limit": ["10"]}, {"url": ["https://www.linkedin.com/company/example"], "posts": ["true"]}]
    assert all(r.method == "GET" for r in server.requests)
    assert social_query({"a": None, "b": False}) == {"b": "false"}
    with pytest.raises(TypeError):
        client.call("/v1/x/search", {"q": ["a", "b"]})
    with pytest.raises(TypeError, match="finite"):
        client.call("/v1/x/search", {"q": "a", "limit": float("inf")})


@pytest.mark.parametrize(
    ("client_class", "bad"),
    [
        (KeywordsClient, ["v1/trend", "/v1/x/search", "/v1/Trend", "https://evil.example/v1/trend", "/v1/trend?x=1"]),
        (SocialClient, ["/v1/search", "/v1/x/search/more", "/v1/X/search", "/v2/x/search", "/v1/x/search#a"]),
    ],
)
def test_refuses_paths_of_another_shape(mock_server: Any, client_class: Any, bad: list[str]) -> None:
    server = mock_server(lambda _request: Reply(status=200, body={}))
    client = client_class(session=requests.Session(), base_url=server.base_url)
    for path in bad:
        with pytest.raises(ValueError):
            client.call(path)
    assert server.requests == []


# ---------------------------------------------------------------- payment and price caps


def offering(amounts: dict[str, int], answer: Callable[[Recorded], Any] = lambda _r: {"ok": 1}) -> Callable[[Recorded], Reply]:
    def reply(request: Recorded) -> Reply:
        if request.payment_signature is None:
            return Reply(status=402, headers={"PAYMENT-REQUIRED": service_challenge_header(f"https://example.invalid{request.path}", amounts[request.path])})
        return Reply(status=200, headers={"PAYMENT-RESPONSE": payment_response_header(PAY_TO)}, body=answer(request))

    return reply


def assert_per_route_caps(server: Any, amounts: dict[str, int], call: Callable[[str], Any], signer: SpySigner, listed: list[tuple[str, str, int]]) -> None:
    for path, method, amount in listed:
        amounts[path] = amount
        before = len(server.requests)
        call(path)
        sent = server.requests[before:]
        assert [r.method for r in sent] == [method, method], path
        paid = [r for r in sent if r.payment_signature is not None]
        assert len(paid) == 1, path
        assert decode_payment_signature(paid[0].payment_signature or "")["payload"]["authorization"]["value"] == str(amount), path

        amounts[path] = amount + 1
        signatures = signer.signatures
        before = len(server.requests)
        with pytest.raises(PriceGuardError):
            call(path)
        assert signer.signatures == signatures, f"{path} signed at listed + 1"
        assert all(r.payment_signature is None for r in server.requests[before:]), path


def listed(ops: list[tuple[str, str, dict[str, Any]]]) -> list[tuple[str, str, int]]:
    return [(path, method, atomic(op["x-payment-info"]["price"]["amount"])) for path, method, op in ops]


@pytest.mark.parametrize(("client_class", "_routes", "ops", "_origin"), SERVICES)
def test_every_route_is_capped_at_its_own_price(mock_server: Any, throwaway_account: Any, client_class: Any, _routes: Any, ops: Any, _origin: str) -> None:
    amounts: dict[str, int] = {}
    server = mock_server(offering(amounts))
    signer = SpySigner(throwaway_account)
    assert_per_route_caps(server, amounts, client_class(signer, base_url=server.base_url).call, signer, listed(ops))


def test_duo_client_keywords_and_social_cap_every_route_at_its_own_price(mock_server: Any, throwaway_account: Any) -> None:
    amounts: dict[str, int] = {}
    server = mock_server(offering(amounts))
    signer = SpySigner(throwaway_account)
    client = DuoClient(signer, keywords_base_url=server.base_url, social_base_url=server.base_url)
    assert_per_route_caps(server, amounts, client.keywords.call, signer, listed(KW_OPS))
    assert_per_route_caps(server, amounts, client.social.call, signer, listed(SOCIAL_OPS))


def test_a_paid_post_resends_the_same_body(mock_server: Any, throwaway_account: Any) -> None:
    server = mock_server(offering({"/v1/keyword-gap": 48000}, answer=lambda r: {"echo": r.json()}))
    signer = SpySigner(throwaway_account)
    result = KeywordsClient(signer, base_url=server.base_url).call_with_receipt("/v1/keyword-gap", {"domain": "example.com", "competitor": "example.org", "limit": 5})
    assert result.data == {"echo": {"domain": "example.com", "competitor": "example.org", "limit": 5}}
    assert result.receipt is not None and result.receipt.success is True
    unpaid, paid = server.requests
    assert unpaid.body == paid.body and unpaid.payment_signature is None and paid.payment_signature is not None
    assert paid.content_type == "application/json"
    signed = decode_payment_signature(paid.payment_signature or "")["payload"]["authorization"]
    assert (signed["to"], signed["value"]) == (PAY_TO, "48000")
    assert signer.signatures == 1


@pytest.mark.parametrize(
    ("make", "path", "amount", "pays"),
    [
        (lambda s, url: KeywordsClient(s, base_url=url, max_price_usd=0.04), "/v1/trend", 45000, False),
        (lambda s, url: KeywordsClient(s, base_url=url, max_price_usd=0.05), "/v1/trend", 50000, True),
        (lambda s, url: DuoClient(s, keywords_base_url=url, keywords_max_price_usd=0.04).keywords, "/v1/historical-rank", 250000, False),
        (lambda s, url: SocialClient(s, base_url=url, max_price_usd=0.01), "/v1/x/search", 20000, False),
        (lambda s, url: DuoClient(s, social_base_url=url, social_max_price_usd=0.03).social, "/v1/x/search", 30000, True),
    ],
)
def test_an_explicit_cap_overrides_the_per_route_default(mock_server: Any, throwaway_account: Any, make: Any, path: str, amount: int, pays: bool) -> None:
    server = mock_server(offering({path: amount}))
    signer = SpySigner(throwaway_account)
    if pays:
        make(signer, server.base_url).call(path)
    else:
        with pytest.raises(PriceGuardError):
            make(signer, server.base_url).call(path)
    assert signer.signatures == (1 if pays else 0)


@pytest.mark.parametrize(
    ("client_class", "path", "refused_at", "message"),
    [(KeywordsClient, "/v1/not-listed", 45001, r"\$0\.045"), (SocialClient, "/v1/x/not-listed", 25001, r"\$0\.025")],
)
def test_an_unknown_path_keeps_the_default_cap(mock_server: Any, throwaway_account: Any, client_class: Any, path: str, refused_at: int, message: str) -> None:
    server = mock_server(offering({path: refused_at}))
    signer = SpySigner(throwaway_account)
    with pytest.raises(PriceGuardError, match=rf"above the maximum {message}"):
        client_class(signer, base_url=server.base_url).call(path)
    assert signer.signatures == 0


@pytest.mark.parametrize("client_class", [KeywordsClient, SocialClient])
def test_refuses_another_payee_or_network(mock_server: Any, throwaway_account: Any, client_class: Any) -> None:
    from helpers import challenge_header

    def reply(_request: Recorded) -> Reply:
        def edit(challenge: dict[str, Any]) -> None:
            challenge["accepts"][0]["amount"] = "10000"
            challenge["accepts"][0]["payTo"] = "0x000000000000000000000000000000000000dEaD"

        return Reply(status=402, headers={"PAYMENT-REQUIRED": challenge_header(edit)})

    server = mock_server(reply)
    signer = SpySigner(throwaway_account)
    path = "/v1/on-page" if client_class is KeywordsClient else "/v1/bluesky/search"
    with pytest.raises(PriceGuardError, match="payTo"):
        client_class(signer, base_url=server.base_url).call(path, {"q": "x"} if client_class is SocialClient else {"url": "https://example.com"})
    assert signer.signatures == 0
    assert len(server.requests) == 1


# ---------------------------------------------------------------- error mapping


@pytest.mark.parametrize("client_class", [KeywordsClient, SocialClient])
@pytest.mark.parametrize(
    ("reply", "code", "status", "param", "expected", "request_id"),
    [
        (
            Reply(status=400, body={"error": {"status": 400, "code": "INVALID_PARAM", "message": "q is empty", "param": "q", "expected": "1-200 characters"}, "request_id": "01REQ"}),
            "INVALID_PARAM", 400, "q", "1-200 characters", "01REQ",
        ),
        (
            Reply(status=503, body={"error": {"status": 503, "code": "UPSTREAM_UNAVAILABLE", "message": "nothing was charged"}}),
            "UPSTREAM_UNAVAILABLE", 503, None, None, None,
        ),
        (Reply(status=404, body={"error": {"status": 404, "code": "NOT_FOUND", "message": "no route"}, "request_id": "01X"}), "NOT_FOUND", 404, None, None, "01X"),
        (Reply(status=402), "PAYMENT_REQUIRED", 402, None, None, None),
        (Reply(status=200, body=["not", "an", "object"]), "INVALID_RESPONSE", 200, None, None, None),
        (Reply(status=200, body={"error": {"code": "LATE", "message": "late failure"}}), "LATE", 200, None, None, None),
        (Reply(status=500), "HTTP_500", 500, None, None, None),
        (Reply(status=502, body={"error": "flat string"}), "HTTP_502", 502, None, None, None),
    ],
)
def test_error_mapping(mock_server: Any, client_class: Any, reply: Reply, code: str, status: int, param: Any, expected: Any, request_id: Any) -> None:
    server = mock_server(lambda _request: reply)
    path = "/v1/serp" if client_class is KeywordsClient else "/v1/hackernews/search"
    with pytest.raises(DuoApiError) as caught:
        client_class(session=requests.Session(), base_url=server.base_url).call(path, {"q": "x"})
    error = caught.value
    assert (error.code, error.status, error.route, error.param, error.expected, error.request_id) == (code, status, path, param, expected, request_id)


def test_a_post_route_error_is_mapped_too(mock_server: Any) -> None:
    server = mock_server(lambda _request: Reply(status=400, body={"error": {"status": 400, "code": "INVALID_PARAM", "message": "keywords: 1-100", "param": "keywords"}}))
    with pytest.raises(DuoApiError) as caught:
        KeywordsClient(session=requests.Session(), base_url=server.base_url).keyword_overview(keywords=[])
    assert (caught.value.code, caught.value.param, caught.value.route) == ("INVALID_PARAM", "keywords", "/v1/keyword-overview")
    assert server.requests[0].method == "POST"


# ---------------------------------------------------------------- construction


@pytest.mark.parametrize("client_class", [KeywordsClient, SocialClient])
def test_construction_rules(client_class: Any, throwaway_account: Any) -> None:
    with pytest.raises(TypeError):
        client_class()
    with pytest.raises(TypeError):
        client_class(throwaway_account, session=requests.Session())
    with pytest.raises(ValueError):
        client_class(throwaway_account, base_url="http://example.com")
    with pytest.raises(ValueError):
        client_class(throwaway_account, max_price_usd=0)
    with pytest.raises(ValueError):
        client_class(throwaway_account, user_agent="a\nb")
    client_class(throwaway_account, base_url="http://localhost:8787")


def test_duo_client_shares_the_session(mock_server: Any) -> None:
    server = mock_server(lambda _request: Reply(status=200, body={"ok": 1}))
    session = requests.Session()
    client = DuoClient(session=session, keywords_base_url=server.base_url, social_base_url=server.base_url, timeout=5)
    assert client.keywords.call("/v1/tech-stack", {"target": "example.com"}) == {"ok": 1}
    assert client.social.call("/v1/x/profile", {"handle": "example"}) == {"ok": 1}
    assert [r.method for r in server.requests] == ["POST", "GET"]
