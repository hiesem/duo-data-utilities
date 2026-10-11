"""Helpers shared by the tests. Loopback only: nothing here touches the internet."""

from __future__ import annotations

import base64
import http.server
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from x402.mechanisms.evm.signers import EthAccountSigner

SPEC = Path(__file__).resolve().parents[2] / "spec"
PAY_TO = "0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39"
BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def b64_json(value: Any) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def fixture_challenge() -> dict[str, Any]:
    """The real PAYMENT-REQUIRED challenge captured from /v1/id/iban, decoded."""
    fixture = json.loads((SPEC / "fixtures" / "iban-402-challenge.json").read_text(encoding="utf-8"))
    return json.loads(base64.b64decode(fixture["response"]["headers"]["payment-required"]))


def challenge_header(edit: Callable[[dict[str, Any]], None] | None = None) -> str:
    challenge = fixture_challenge()
    if edit is not None:
        edit(challenge)
    return b64_json(challenge)


def payment_response_header(payer: str) -> str:
    return b64_json({"success": True, "transaction": "0x" + "ab" * 32, "network": "eip155:8453", "payer": payer})


def decode_payment_signature(header: str) -> dict[str, Any]:
    return json.loads(base64.b64decode(header))


def envelope(route: str, data: Any) -> dict[str, Any]:
    return {
        "ok": True,
        "route": route,
        "version": "1.0.0",
        "data": data,
        "meta": {
            "request_id": "01TESTREQUEST000000000000",
            "computed_at": "2026-10-09T00:00:00.000Z",
            "price_usd": "0.05",
            "deterministic": True,
            "disclaimer": "test fixture",
        },
    }


@dataclass
class Recorded:
    method: str
    path: str
    query: dict[str, list[str]]
    payment_signature: str | None
    user_agent: str | None = None


@dataclass
class Reply:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: Any = None


class MockServer:
    """A loopback HTTP server. Every request is recorded and answered by `reply`."""

    def __init__(self, reply: Callable[[Recorded], Reply]) -> None:
        self.requests: list[Recorded] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server naming
                url = urlsplit(self.path)
                recorded = Recorded(
                    method="GET",
                    path=url.path,
                    query=parse_qs(url.query, keep_blank_values=True),
                    payment_signature=self.headers.get("PAYMENT-SIGNATURE"),
                    user_agent=self.headers.get("User-Agent"),
                )
                outer.requests.append(recorded)
                answer = reply(recorded)
                payload = b"" if answer.body is None else json.dumps(answer.body).encode("utf-8")
                self.send_response(answer.status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                for name, value in answer.headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args: Any) -> None:
                return

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


class SpySigner:
    """Wraps x402's EthAccountSigner and counts how many signatures it produced."""

    def __init__(self, account: Any) -> None:
        self._inner = EthAccountSigner(account)
        self.signatures = 0

    @property
    def address(self) -> str:
        return self._inner.address

    def sign_typed_data(self, *args: Any, **kwargs: Any) -> Any:
        self.signatures += 1
        return self._inner.sign_typed_data(*args, **kwargs)
