"""LangChain tools backed by duo-data-utilities.

Cost: $0.05 per call (x402, USDC on Base). validate_iban costs $0.05. check_counterparty costs $0.15
(three calls). Needs DUO_PAYER_KEY: a 0x-prefixed private key for a wallet that holds a little USDC on Base.
Never write a key into this file. Install: pip install "git+https://github.com/hiesem/duo-data-utilities#subdirectory=python" langchain-core
Not run in CI.
"""

import os
from functools import lru_cache

from eth_account import Account
from langchain_core.tools import tool

from duo_data_utilities import DuoClient


@lru_cache(maxsize=1)
def client() -> DuoClient:
    key = os.environ.get("DUO_PAYER_KEY", "")
    if not key.startswith("0x"):
        raise RuntimeError("set DUO_PAYER_KEY to a 0x-prefixed private key")
    # The price guard refuses any price above $0.05 per call before it signs.
    return DuoClient(Account.from_key(key))


@tool
def validate_iban(iban: str) -> dict:
    """Check an IBAN: length, mod-97 check digits, and the bank, branch and account breakdown. Costs $0.05."""
    return client().iban.validate(iban=iban)


@tool
def check_counterparty(iban: str, country: str, tax_id_type: str, tax_id: str) -> dict:
    """Check an IBAN, a tax ID and a country together. Structure and checksum only. Costs $0.15."""
    result = client().check_counterparty(iban=iban, country=country, tax_id_type=tax_id_type, tax_id=tax_id)
    return {"verdict": result.verdict, "reasons": result.reasons}


if __name__ == "__main__":
    print(validate_iban.invoke({"iban": "NL91 ABNA 0417 1643 00"}))
