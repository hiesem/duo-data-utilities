"""Offline smoke test of x402-seo-keyword-data: route table, per-route price caps and one request against a loopback server.
Nothing touches the internet and nothing is paid (no wallet is used: the session does not pay)."""

from __future__ import annotations

import http.server
import json
import threading
from typing import Any

import pytest
import requests

from x402_seo_keyword_data import SEO_KEYWORD_ROUTES, Client, DuoApiError, KeywordsClient


class _Server:
    def __init__(self, status: int, body: Any) -> None:
        self.seen: list[tuple[str, str, bytes]] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                outer.seen.append((self.command, self.path, self.rfile.read(length) if length else b""))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = _answer

            def log_message(self, *_args: Any) -> None:
                return

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def test_route_table() -> None:
    assert len(SEO_KEYWORD_ROUTES) == 44
    assert len({r["path"] for r in SEO_KEYWORD_ROUTES}) == 44
    assert Client is KeywordsClient


def test_every_route_is_capped_at_its_own_price() -> None:
    client = KeywordsClient(session=requests.Session())
    for route in SEO_KEYWORD_ROUTES:
        assert client._cap_for(route["path"]) == float(route["price_usd"])
        assert int(route["amount"]) == round(float(route["price_usd"]) * 1_000_000)
        assert callable(getattr(client, route["method"]))
    assert KeywordsClient(session=requests.Session(), max_price_usd=0.001)._cap_for(SEO_KEYWORD_ROUTES[0]["path"]) == 0.001


def test_one_request_and_an_error() -> None:
    server = _Server(200, {"ok": 1})
    try:
        assert KeywordsClient(session=requests.Session(), base_url=server.url).call("/v1/keyword-gap", {"domain": "example.com", "competitor": "example.org"}) == {"ok": 1}
        assert server.seen[0][0] == "POST"
    finally:
        server.close()
    server = _Server(400, {"error": {"code": "INVALID_PARAM", "message": "bad", "param": "x"}})
    try:
        with pytest.raises(DuoApiError) as caught:
            KeywordsClient(session=requests.Session(), base_url=server.url).call("/v1/keyword-gap", {"domain": "example.com", "competitor": "example.org"})
        assert (caught.value.code, caught.value.status) == ("INVALID_PARAM", 400)
    finally:
        server.close()
