"""KYB / payout beneficiary data-validation agent (Claude tool use + duo-data-utilities).

Give it a payout request in plain language ("pay 1,250 EUR to Muster Maschinenbau GmbH, IBAN ..., USt-IdNr ...").
Claude decides which checks to run and calls these tools, each backed by https://api.duoleads.com:

    validate_iban      /v1/id/iban          length, mod-97 check digits, bank code
    build_iban         /v1/id/iban-build    IBAN from country + bank code + account number
    validate_tax_id    /v1/id/national      VAT, tax ID or company number checksum (23 countries)
    lookup_country     /v1/ref/country      ISO 3166 country, currency, region
    compare_names      /v1/text/similarity  beneficiary name vs account holder name (Jaro-Winkler)

It ends with a verdict: APPROVE, REVIEW or REJECT, and the reasons. Structure and checksum only: no company
register, bank or tax authority is queried, and the account's existence is not confirmed.

Cost: $0.05 per tool call, paid in USDC on Base via x402 from YOUR wallet (DUO_PAYER_KEY). The agent stops
paying after DUO_MAX_CALLS calls (default 6, i.e. at most $0.30 per run). Claude usage is billed by Anthropic.

    DUO_PAYER_KEY=0x... ANTHROPIC_API_KEY=sk-ant-... python kyb_agent.py "Pay 980 EUR to ..."
    DUO_PAYER_KEY=0x... python kyb_agent.py --rules beneficiary.example.json   # no LLM, fixed checks
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from duo_data_utilities import USER_AGENT, DuoApiError, DuoClient

MODEL = "claude-opus-5-5"
PRICE_USD = 0.05

SYSTEM_PROMPT = """You check payout beneficiaries (businesses) before money is sent.
Use the tools to validate every identifier in the request: the IBAN (or build it from bank code and account
number), the VAT or tax number for the beneficiary's country, and, when an account holder name is given, compare
it with the beneficiary name. Each tool call costs $0.05, so call each check once and do not repeat a call with
the same input. The checks are structure and checksum only; say so, and never claim an account or company exists.
Finish with one line "VERDICT: APPROVE", "VERDICT: REVIEW" or "VERDICT: REJECT", followed by the reasons.
REJECT when an identifier fails its checksum, REVIEW when something could not be checked, the IBAN country
differs from the beneficiary country, or the names differ (Jaro-Winkler below 0.85)."""

# VAT and company-number kinds as /v1/id/national names them, so the model can pick one.
TAX_KINDS = "NL btw/kvk, BE vat, DE ustid, FR tva/siren/siret, IT piva, ES cif/nif, PL nip, AT uid, CH uid, IE vat, SE orgnr, NO orgnr, DK cvr, FI ytunnus, UK utr/crn, AU abn, BR cnpj, US ein"


def _tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False},
    }


_STR = {"type": "string"}

TOOLS: list[dict[str, Any]] = [
    _tool("validate_iban", "Validate an IBAN: length for its country, mod-97 check digits, bank/branch/account breakdown. $0.05.", {"iban": _STR}),
    _tool(
        "build_iban",
        "Build an IBAN from an ISO 3166-1 alpha-2 country, a bank code and an account number, computing the check digits. $0.05.",
        {"country": _STR, "bank": _STR, "account": _STR},
    ),
    _tool(
        "validate_tax_id",
        f"Check a VAT number, tax ID or company number against its country's checksum rule. kind is one of: {TAX_KINDS}. $0.05.",
        {"country": _STR, "kind": _STR, "value": _STR},
    ),
    _tool("lookup_country", "Look up an ISO 3166 country code: name, currencies, UN region. $0.05.", {"code": _STR}),
    _tool(
        "compare_names",
        "Compare two names (case, accents, spaces and punctuation folded). Returns Jaro-Winkler similarity 0-1. $0.05.",
        {"a": _STR, "b": _STR},
    ),
]


@dataclass
class PaidTools:
    """Runs the tools against the API and stops paying after max_calls calls."""

    client: DuoClient
    max_calls: int = 6
    calls: int = 0
    log: list[str] = field(default_factory=list)

    def _handlers(self) -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
        c = self.client
        return {
            "validate_iban": lambda a: c.iban.validate(iban=a["iban"]),
            "build_iban": lambda a: c.iban.generate(country=a["country"], bank=a["bank"], account=a["account"]),
            "validate_tax_id": lambda a: c.tax_id.validate(country=a["country"], kind=a["kind"], value=a["value"]),
            "lookup_country": lambda a: c.country.lookup(code=a["code"]),
            "compare_names": lambda a: c.text.similarity(a=a["a"], b=a["b"], fold="case,accents,space,punct", only="jaro_winkler"),
        }

    def run(self, name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        """Returns (JSON text for the tool result, is_error)."""
        handler = self._handlers().get(name)
        if handler is None:
            return json.dumps({"error": f"unknown tool {name}"}), True
        if self.calls >= self.max_calls:
            return json.dumps({"error": f"spend cap reached ({self.max_calls} paid calls); decide with what you have"}), True
        self.calls += 1
        self.log.append(f"{name} {json.dumps(arguments, ensure_ascii=False)}")
        try:
            return json.dumps(handler(arguments), ensure_ascii=False), False
        except DuoApiError as error:
            # A malformed or unsupported input is a result the model can reason about, not a crash.
            return json.dumps({"error": error.code, "message": str(error), "param": error.param, "expected": error.expected}), True


def run_agent(request: str, tools: PaidTools, *, max_turns: int = 10) -> str:
    """Claude tool-use loop. Returns Claude's final text (ending in a VERDICT line)."""
    import anthropic  # imported here so the rest of this file works without the Anthropic SDK installed

    claude = anthropic.Anthropic()  # ANTHROPIC_API_KEY, or an `ant auth login` profile
    messages: list[dict[str, Any]] = [{"role": "user", "content": request}]
    for _ in range(max_turns):
        response = claude.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
            # On a safety decline the API retries on a fallback model inside the same call.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if response.stop_reason in ("refusal", "max_tokens"):
            return f"VERDICT: REVIEW\nThe model stopped early ({response.stop_reason}); check this payout by hand."
        if response.stop_reason != "tool_use":
            return "".join(block.text for block in response.content if block.type == "text")

        # Keep the assistant turn unchanged (it carries thinking and tool_use blocks), then answer every tool call.
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for block in response.content:
            if block.type == "tool_use":
                text, is_error = tools.run(block.name, dict(block.input))
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": text, "is_error": is_error})
        messages.append({"role": "user", "content": results})
    return "VERDICT: REVIEW\nThe agent hit its turn limit; check this payout by hand."


def run_rules(beneficiary: dict[str, Any], tools: PaidTools) -> str:
    """The same checks without an LLM, for a structured beneficiary record (see beneficiary.example.json)."""
    reasons: list[str] = []
    verdict = "APPROVE"

    def flag(level: str, reason: str) -> None:
        nonlocal verdict
        reasons.append(reason)
        if level == "REJECT" or verdict == "REJECT":
            verdict = "REJECT"
        else:
            verdict = "REVIEW"

    country = beneficiary["country"].upper()
    iban = beneficiary.get("iban")
    if not iban and beneficiary.get("bank") and beneficiary.get("account"):
        text, err = tools.run("build_iban", {"country": country, "bank": beneficiary["bank"], "account": beneficiary["account"]})
        iban = None if err else json.loads(text)["iban"]
        if err:
            flag("REJECT", f"IBAN could not be built: {text}")
    if iban:
        text, err = tools.run("validate_iban", {"iban": iban})
        data = json.loads(text)
        if err or not data.get("valid"):
            flag("REJECT", f"IBAN invalid: {data.get('reason') or data.get('message')}")
        elif data["country"] != country:
            flag("REVIEW", f"IBAN country {data['country']} differs from beneficiary country {country}")
    else:
        flag("REVIEW", "no IBAN")
    if beneficiary.get("tax_id") and beneficiary.get("tax_kind"):
        text, err = tools.run("validate_tax_id", {"country": country, "kind": beneficiary["tax_kind"], "value": beneficiary["tax_id"]})
        data = json.loads(text)
        if err:
            flag("REVIEW" if data.get("error") == "UNSUPPORTED_VALUE" else "REJECT", f"tax ID not checked: {data.get('message')}")
        elif not data["valid"]:
            flag("REJECT", f"tax ID invalid: {data['reason']}")
    else:
        flag("REVIEW", "no tax ID")
    if beneficiary.get("account_holder"):
        text, err = tools.run("compare_names", {"a": beneficiary["name"], "b": beneficiary["account_holder"]})
        score = json.loads(text).get("jaro_winkler", 0.0) if not err else 0.0
        if score < 0.85:
            flag("REVIEW", f"account holder name differs (Jaro-Winkler {score:.2f})")
    return f"VERDICT: {verdict}\n" + "\n".join(f"- {r}" for r in reasons or ["all checks passed (structure and checksum only)"])


def make_tools() -> PaidTools:
    from eth_account import Account

    key = os.environ.get("DUO_PAYER_KEY", "")
    if not key.startswith("0x"):
        raise SystemExit("set DUO_PAYER_KEY to the 0x-prefixed private key of a Base wallet holding a little USDC")
    # The client refuses to sign more than $0.05 per call, or for any payee other than the service.
    client = DuoClient(Account.from_key(key), user_agent=f"{USER_AGENT} kyb-payout-agent/1.0")
    return PaidTools(client, max_calls=int(os.environ.get("DUO_MAX_CALLS", "6")))


def main(argv: list[str]) -> None:
    if len(argv) >= 2 and argv[0] == "--rules":
        tools = make_tools()
        print(run_rules(json.loads(Path(argv[1]).read_text(encoding="utf-8")), tools))
    elif argv:
        tools = make_tools()
        print(run_agent(" ".join(argv), tools))
    else:
        raise SystemExit(__doc__)
    print(f"\n{tools.calls} paid calls, ${tools.calls * PRICE_USD:.2f}:", *tools.log, sep="\n  ", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
