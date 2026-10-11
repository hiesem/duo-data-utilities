"""The Python examples compile, and the KYB agent's rule path runs offline against a loopback mock server."""

from __future__ import annotations

import importlib.util
import json
import py_compile
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import requests
from helpers import Recorded, Reply, envelope

from duo_data_utilities import DuoClient

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"
KYB = EXAMPLES / "kyb-payout-agent-python"


def load_kyb() -> ModuleType:
    spec = importlib.util.spec_from_file_location("kyb_agent", KYB / "kyb_agent.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["kyb_agent"] = module  # dataclasses look the module up while the class is created
    spec.loader.exec_module(module)
    return module


def test_every_python_example_compiles(tmp_path: Path) -> None:
    files = sorted(EXAMPLES.rglob("*.py"))
    assert len(files) >= 2
    for file in files:
        py_compile.compile(str(file), cfile=str(tmp_path / (file.stem + ".pyc")), doraise=True)


def fake_api(request: Recorded) -> Reply:
    q = {k: v[0] for k, v in request.query.items()}
    data: dict[str, Any]
    if request.path == "/v1/id/iban-build":
        data = {"iban": "DE89370400440532013000", "iban_print": "DE89 3704 0044 0532 0130 00", "country": "DE", "valid": True}
    elif request.path == "/v1/id/iban":
        data = {"valid": True, "iban": q["iban"], "country": q["iban"][:2], "reason": None}
    elif request.path == "/v1/id/national":
        data = {"valid": True, "country": q["country"], "kind": q["kind"], "reason": None, "algorithm": "iso-7064-mod-11-10"}
    elif request.path == "/v1/text/similarity":
        data = {"jaro_winkler": 1.0 if q["a"] == q["b"] else 0.4, "equal_after_fold": q["a"] == q["b"], "folded": {"a": q["a"], "b": q["b"]}}
    else:
        return Reply(status=404, body={"ok": False, "error": {"code": "NOT_FOUND", "message": "no such route"}})
    return Reply(status=200, body=envelope(request.path, data))


def test_kyb_rules_approve_the_sample_beneficiary(mock_server: Any) -> None:
    kyb = load_kyb()
    server = mock_server(fake_api)
    tools = kyb.PaidTools(DuoClient(session=requests.Session(), base_url=server.base_url))
    beneficiary = json.loads((KYB / "beneficiary.example.json").read_text(encoding="utf-8"))
    assert kyb.run_rules(beneficiary, tools).startswith("VERDICT: APPROVE")
    assert [r.path for r in server.requests] == ["/v1/id/iban-build", "/v1/id/iban", "/v1/id/national", "/v1/text/similarity"]


def test_kyb_spend_cap_stops_paying(mock_server: Any) -> None:
    kyb = load_kyb()
    server = mock_server(fake_api)
    tools = kyb.PaidTools(DuoClient(session=requests.Session(), base_url=server.base_url), max_calls=1)
    assert tools.run("validate_iban", {"iban": "NL91ABNA0417164300"})[1] is False
    text, is_error = tools.run("validate_iban", {"iban": "NL91ABNA0417164300"})
    assert is_error and "spend cap" in text
    assert len(server.requests) == 1


def test_kyb_tools_are_strict_and_match_handlers() -> None:
    kyb = load_kyb()
    handlers = kyb.PaidTools(DuoClient(session=requests.Session()))._handlers()
    assert {tool["name"] for tool in kyb.TOOLS} == set(handlers)
    for tool in kyb.TOOLS:
        schema = tool["input_schema"]
        assert tool["strict"] is True and schema["additionalProperties"] is False
        assert schema["required"] == list(schema["properties"])
