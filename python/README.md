# duo-data-utilities (Python)

Typed Python client for https://api.duoleads.com: IBAN, ISIN, VAT/tax ID, GTIN barcode and 29 more pay-per-call utilities. Each call costs $0.05 in USDC on Base, paid with x402 v2. No API key, no signup.

```sh
pip install "git+https://github.com/hiesem/duo-data-utilities#subdirectory=python"
```

The package is not published to PyPI. The full documentation, the method table and the price guard are in the repository README.

The client sends a User-Agent naming the SDK and version (`duo-data-utilities-py/<version> (+https://github.com/hiesem/duo-data-utilities)`); the API stores only a coarse client class, see https://api.duoleads.com/privacy. Pass `user_agent=` to `DuoClient` to change it.
