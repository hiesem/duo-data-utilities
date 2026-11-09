#!/usr/bin/env python3
"""Generates the Python clients' route modules from the committed spec snapshots (see spec/README.md):

  python/duo_data_utilities/generated.py            spec/manifest.json, spec/keywords.json, spec/methods.json (main API)
  python/duo_data_utilities/derivs_generated.py     spec/derivs.json, spec/derivs-methods.json
  python/duo_data_utilities/keywords_generated.py   spec/keywords-openapi.json (keywords.duoleads.com)
  python/duo_data_utilities/social_generated.py     spec/social-openapi.json (social.duoleads.com)

and the standalone per-service packages in python-packages/<name>/: each gets a copy of exactly the shared modules
its client imports (transitively), its own _version.py (its own distribution name) and the LICENSE. Nothing in
python-packages/<name>/<import name>/ but __init__.py is edited by hand.

Usage: python3 python/scripts/generate.py          write every file
       python3 python/scripts/generate.py --check  exit 1 if any file is stale
"""

from __future__ import annotations

import json
import keyword
import re
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "python" / "duo_data_utilities" / "generated.py"
DERIVS_TARGET = ROOT / "python" / "duo_data_utilities" / "derivs_generated.py"
KEYWORDS_TARGET = ROOT / "python" / "duo_data_utilities" / "keywords_generated.py"
SOCIAL_TARGET = ROOT / "python" / "duo_data_utilities" / "social_generated.py"
PACKAGE_DIR = ROOT / "python" / "duo_data_utilities"
SERVICE_PACKAGES_DIR = ROOT / "python-packages"
# The standalone per-service packages (same names as the npm packages in packages/): distribution name ->
# (import name, the umbrella module whose client it ships).
SERVICE_PACKAGES: dict[str, tuple[str, str]] = {
    "x402-seo-keyword-data": ("x402_seo_keyword_data", "keywords.py"),
    "x402-crypto-derivatives-data": ("x402_crypto_derivatives_data", "derivs.py"),
    "x402-social-media-data": ("x402_social_media_data", "social.py"),
}


def read_json(relative: str) -> Any:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def class_name(namespace: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in namespace.split("_")) + "Namespace"


def py_ident(wire_name: str) -> str:
    # Query names that are Python keywords (e.g. "from") keep their wire name and get a trailing underscore.
    ident = wire_name + "_" if keyword.iskeyword(wire_name) else wire_name
    if not ident.isidentifier():
        raise SystemExit(f"parameter {wire_name} is not usable as a Python name")
    return ident


def one_line(text: Any) -> str:
    return " ".join(str(text).split()).replace("\\", "\\\\").replace('"""', '\\"\\"\\"')


def sentence(text: Any) -> str:
    return one_line(text).rstrip(".") + "."


def py_type(param: dict[str, Any]) -> str:
    if param["kind"] == "boolean":
        return "bool"
    if param["kind"] == "integer":
        return "int"
    if param["kind"] == "number":
        return "float"
    if param.get("enum"):
        return "Literal[" + ", ".join(json.dumps(str(value)) for value in param["enum"]) + "]"
    return "str"


def param_doc(param: dict[str, Any]) -> str:
    parts = [one_line(param["description"])]
    if param.get("expected"):
        parts.append(f"Expected: {sentence(param['expected'])}")
    if "default" in param:
        parts.append(f"Default: {json.dumps(param['default'])}.")
    return " ".join(parts)


def method_source(route: dict[str, Any], method: str) -> str:
    params = route["params"]
    ordered = [p for p in params if p["required"]] + [p for p in params if not p["required"]]
    signature = ["self", "*"]
    for param in ordered:
        if param["required"]:
            signature.append(f"{py_ident(param['name'])}: {py_type(param)}")
        else:
            signature.append(f"{py_ident(param['name'])}: {py_type(param)} | None = None")
    lines = [f"    def {method}({', '.join(signature)}) -> dict[str, Any]:"]
    lines.append('        """' + sentence(route["summary"]) + f" Costs ${route['price_usd']} per call.")
    lines.append("")
    lines.append(f"        Route: GET {route['path']}")
    if params:
        lines.append("")
        lines.append("        Args:")
        for param in params:
            lines.append(f"            {py_ident(param['name'])}: {param_doc(param)}")
    lines.append('        """')
    body = ", ".join(f'"{p["name"]}": {py_ident(p["name"])}' for p in params)
    lines.append(f'        return self._call("{route["path"]}", {{{body}}})')
    return "\n".join(lines)


def build() -> str:
    manifest = read_json("spec/manifest.json")
    keywords = read_json("spec/keywords.json")["routes"]
    methods = read_json("spec/methods.json")["routes"]
    if not manifest.get("ok") or manifest.get("route") != "/v1/manifest":
        raise SystemExit("spec/manifest.json is not a /v1/manifest envelope")
    routes = manifest["data"]["routes"]
    if len(routes) != 33:
        raise SystemExit(f"manifest has {len(routes)} routes, expected 33")
    for route in routes:
        if route["path"] not in keywords or route["path"] not in methods:
            raise SystemExit(f"{route['path']} is missing from keywords.json or methods.json")

    groups: dict[str, list[tuple[dict[str, Any], str, str]]] = {}
    for route in routes:
        namespace = snake(methods[route["path"]]["namespace"])
        method = snake(methods[route["path"]]["method"])
        route_info = {"summary": keywords[route["path"]]["summary"], **route}
        groups.setdefault(namespace, []).append((route_info, method, keywords[route["path"]]["tool"]))

    out: list[str] = []
    out.append('"""Typed methods for every route.')
    out.append("")
    out.append("Generated by python/scripts/generate.py from spec/manifest.json, spec/keywords.json and spec/methods.json.")
    out.append("Do not edit by hand. Refresh the snapshots, then run `python3 python/scripts/generate.py`.")
    out.append('"""')
    out.append("")
    out.append("from __future__ import annotations")
    out.append("")
    out.append("from collections.abc import Callable, Mapping")
    out.append("from typing import Any, Literal, TypedDict")
    out.append("")
    out.append("CallRoute = Callable[[str, Mapping[str, Any]], dict[str, Any]]")
    out.append("")
    out.append("")
    out.append("class RouteInfo(TypedDict):")
    out.append("    path: str")
    out.append("    tool: str")
    out.append("    namespace: str")
    out.append("    method: str")
    out.append("    price_usd: str")
    out.append("")
    out.append("")
    out.append("ROUTES: tuple[RouteInfo, ...] = (")
    for namespace, items in groups.items():
        for route, method, tool in items:
            out.append(
                f'    {{"path": "{route["path"]}", "tool": "{tool}", "namespace": "{namespace}", '
                f'"method": "{method}", "price_usd": "{route["price_usd"]}"}},'
            )
    out.append(")")
    out.append("")
    for namespace, items in groups.items():
        out.append("")
        out.append(f"class {class_name(namespace)}:")
        out.append(f'    """Routes in the {namespace} namespace."""')
        out.append("")
        out.append("    def __init__(self, call: CallRoute) -> None:")
        out.append("        self._call = call")
        for route, method, _tool in items:
            out.append("")
            out.append(method_source(route, method))
    out.append("")
    out.append("")
    out.append("class DuoMethods:")
    out.append('    """Every route as a typed method, grouped by namespace. Each call costs $0.05 (paid over x402)."""')
    out.append("")
    out.append("    def __init__(self, call: CallRoute) -> None:")
    for namespace in groups:
        out.append(f"        self.{namespace} = {class_name(namespace)}(call)")
    out.append("")
    return "\n".join(out)


def derivs_usd(amount: str) -> str:
    return f"{int(amount) / 1_000_000:g}"


def derivs_method_source(route: dict[str, Any], method: str, integers: set[str], numbers: set[str]) -> str:
    props: dict[str, Any] = route["querySchema"]["properties"]
    required = set(route["querySchema"]["required"])
    names = [n for n in props if n in required] + [n for n in props if n not in required]

    def py_kind(name: str) -> str:
        if props[name].get("enum"):
            return "Literal[" + ", ".join(json.dumps(str(v)) for v in props[name]["enum"]) + "]"
        if name in integers:
            return "int"
        if name in numbers:
            return "float"
        return "str"

    signature = ["self", "*"]
    for name in names:
        signature.append(f"{py_ident(name)}: {py_kind(name)}" if name in required else f"{py_ident(name)}: {py_kind(name)} | None = None")
    lines = [f"    def {method}({', '.join(signature)}) -> dict[str, Any]:"]
    lines.append('        """' + sentence(route["description"]))
    lines.append("")
    lines.append(f"        Route: GET {route['path']}. Costs ${derivs_usd(route['amount'])} per call ({route['amount']} atomic USDC). MCP tool: {route['tool']}.")
    if names:
        lines.append("")
        lines.append("        Args:")
        for name in props:
            doc = one_line(props[name].get("description", ""))
            if "default" in props[name] and "Default" not in doc:
                doc += f" Default: {json.dumps(props[name]['default'])}."
            lines.append(f"            {py_ident(name)}: {doc}")
    lines.append('        """')
    body = ", ".join(f'"{n}": {py_ident(n)}' for n in props)
    lines.append(f'        return self._call("{route["path"]}", {{{body}}})')
    return "\n".join(lines)


def build_derivs() -> str:
    spec = read_json("spec/derivs.json")
    methods = read_json("spec/derivs-methods.json")["routes"]
    if spec.get("origin") != "https://derivs.duoleads.com":
        raise SystemExit("spec/derivs.json: unexpected origin")
    routes = spec["routes"]
    if len(routes) != 10 or {r["path"] for r in routes} != set(methods):
        raise SystemExit("spec/derivs.json and spec/derivs-methods.json do not list the same 10 routes")

    out: list[str] = []
    out.append('"""Typed methods for the derivs.duoleads.com routes (crypto derivatives data).')
    out.append("")
    out.append("Generated by python/scripts/generate.py from spec/derivs.json and spec/derivs-methods.json.")
    out.append("Do not edit by hand. Refresh the snapshot, then run `python3 python/scripts/generate.py`.")
    out.append('"""')
    out.append("")
    out.append("from __future__ import annotations")
    out.append("")
    out.append("from collections.abc import Callable, Mapping")
    out.append("from typing import Any, Literal, TypedDict")
    out.append("")
    out.append("CallRoute = Callable[[str, Mapping[str, Any]], dict[str, Any]]")
    out.append("")
    out.append("")
    out.append("class DerivsRouteInfo(TypedDict):")
    out.append("    path: str")
    out.append("    tool: str")
    out.append("    method: str")
    out.append("    price_usd: str")
    out.append("    amount: str")
    out.append("")
    out.append("")
    out.append("DERIVS_ROUTES: tuple[DerivsRouteInfo, ...] = (")
    for route in routes:
        method = snake(methods[route["path"]]["method"])
        out.append(
            f'    {{"path": "{route["path"]}", "tool": "{route["tool"]}", "method": "{method}", '
            f'"price_usd": "{derivs_usd(route["amount"])}", "amount": "{route["amount"]}"}},'
        )
    out.append(")")
    out.append("")
    out.append("")
    out.append("class DerivsMethods:")
    out.append('    """Every derivs route as a typed method. Each call costs $0.003 or $0.005 (paid over x402, USDC on Base)."""')
    out.append("")
    out.append("    def __init__(self, call: CallRoute) -> None:")
    out.append("        self._call = call")
    for route in routes:
        m = methods[route["path"]]
        out.append("")
        out.append(derivs_method_source(route, snake(m["method"]), set(m["integers"]), set(m["numbers"])))
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------- OpenAPI services (keywords, social)
# Input: each service's free, published /openapi.json (spec/<service>-openapi.json). Path, HTTP method, MCP tool,
# price and parameters come from it. Method names are the TypeScript client's (scripts/generate.mjs camelPath) in
# snake_case: /v1/keyword-gap -> keyword_gap, /v1/x/search -> x_search. Parameters keep their wire names.

BOOLEAN_STRINGS = {"true", "false", "0", "1"}


def openapi_usd_to_atomic(price: str) -> str:
    if not re.fullmatch(r"\d+(\.\d{1,6})?", price):
        raise SystemExit(f"price {price!r} is not a USD amount with at most 6 decimals")
    return str(int(Decimal(price) * 1_000_000))


def literal_of(values: list[Any]) -> str:
    return "Literal[" + ", ".join(json.dumps(str(v)) for v in values) + "]"


def query_py_type(name: str, schema: dict[str, Any]) -> str:
    enum = schema.get("enum")
    if enum and {str(v) for v in enum} <= BOOLEAN_STRINGS:
        return "bool | " + literal_of(enum)
    if enum:
        return literal_of(enum)
    if schema.get("type") == "integer":
        return "int"
    if schema.get("type") == "number":
        return "float"
    if schema.get("type") == "boolean":
        return "bool"
    if isinstance(schema.get("pattern"), str) and schema["pattern"].startswith("^0*("):
        return "int | str"  # a bounded integer the service reads from the query string
    if name == "keywords":
        return "str | list[str]"  # a comma-separated list; a list is joined (an element with a comma is refused)
    return "str"


def body_py_type(where: str, schema: dict[str, Any]) -> str:
    if schema.get("enum"):
        return literal_of(schema["enum"])
    kind = schema.get("type")
    if kind == "array":
        return f"list[{body_py_type(where, schema.get('items') or {})}]"
    simple = {"string": "str", "integer": "int", "number": "float", "boolean": "bool"}
    if kind in simple:
        return simple[kind]
    raise SystemExit(f"{where}: unsupported body schema {json.dumps(schema)}")


def openapi_model(relative: str, origin: str, count: int, amounts: set[str]) -> list[dict[str, Any]]:
    spec = read_json(relative)
    if (spec.get("servers") or [{}])[0].get("url") != origin:
        raise SystemExit(f"{relative}: unexpected servers[0].url")
    schemas = (spec.get("components") or {}).get("schemas") or {}

    def deref(schema: Any) -> Any:
        if isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
            return schemas[schema["$ref"].removeprefix("#/components/schemas/")]
        return schema

    paths = spec["paths"]
    if len(paths) != count:
        raise SystemExit(f"{relative}: {len(paths)} paths, expected {count}")
    model: list[dict[str, Any]] = []
    for path, ops in paths.items():
        if not re.fullmatch(r"/v1/[a-z0-9]+(/[a-z0-9-]+|-[a-z0-9-]+)*", path):
            raise SystemExit(f"{origin}{path}: unexpected path shape")
        http_method = "GET" if "get" in ops else "POST" if "post" in ops else None
        if http_method is None or set(ops) - {"get", "post"} or len(ops) != 1:
            raise SystemExit(f"{origin}{path}: expected exactly one of GET or POST")
        op = ops[http_method.lower()]
        price = ((op.get("x-payment-info") or {}).get("price") or {}).get("amount")
        if not isinstance(price, str):
            raise SystemExit(f"{origin}{path}: no fixed price")
        amount = openapi_usd_to_atomic(price)
        if amount not in amounts:
            raise SystemExit(f"{origin}{path}: unexpected amount {amount}")
        if not isinstance(op.get("x-mcp-tool"), str):
            raise SystemExit(f"{origin}{path}: no x-mcp-tool")
        params: list[dict[str, Any]] = []
        if http_method == "GET":
            for p in op.get("parameters") or []:
                if p.get("in") != "query":
                    continue
                schema = p.get("schema") or {}
                params.append({"name": p["name"], "required": p.get("required") is True, "description": p.get("description") or "", "default": schema.get("default"), "has_default": "default" in schema, "type": query_py_type(p["name"], schema)})
        else:
            body = deref((((op.get("requestBody") or {}).get("content") or {}).get("application/json") or {}).get("schema")) or {}
            required = set(body.get("required") or [])
            for name, schema in (body.get("properties") or {}).items():
                params.append({"name": name, "required": name in required, "description": schema.get("description") or "", "default": schema.get("default"), "has_default": "default" in schema, "type": body_py_type(f"{origin}{path} {name}", schema)})
        method = re.sub(r"[/-]", "_", path.removeprefix("/v1/"))
        model.append({"path": path, "http_method": http_method, "tool": op["x-mcp-tool"], "description": op.get("description") or op.get("summary") or "", "price_usd": price, "amount": amount, "method": method, "params": params})
    methods = [m["method"] for m in model]
    if len(set(methods)) != len(methods):
        raise SystemExit(f"{origin}: method names collide")
    for m in model:
        if m["method"] in {"call", "call_with_receipt"} or keyword.iskeyword(m["method"]):
            raise SystemExit(f"{origin}{m['path']}: method name {m['method']} is reserved")
    return model


def service_method_source(route: dict[str, Any]) -> str:
    params = route["params"]
    ordered = [p for p in params if p["required"]] + [p for p in params if not p["required"]]
    signature = ["self", "*"]
    for p in ordered:
        signature.append(f"{py_ident(p['name'])}: {p['type']}" if p["required"] else f"{py_ident(p['name'])}: {p['type']} | None = None")
    lines = [f"    def {route['method']}({', '.join(signature)}) -> dict[str, Any]:"]
    lines.append('        """' + sentence(route["description"]))
    lines.append("")
    lines.append(
        f"        Route: {route['http_method']} {route['path']}"
        f"{' (JSON body)' if route['http_method'] == 'POST' else ''}. Costs ${route['price_usd']} per call"
        f" ({route['amount']} atomic USDC). MCP tool: {route['tool']}."
    )
    if params:
        lines.append("")
        lines.append("        Args:")
        for p in params:
            doc = one_line(p["description"])
            if p["has_default"] and "Default" not in doc:
                doc += f" Default: {json.dumps(p['default'])}."
            lines.append(f"            {py_ident(p['name'])}: {doc}".rstrip())
    lines.append('        """')
    body = ", ".join(f'"{p["name"]}": {py_ident(p["name"])}' for p in params)
    lines.append(f'        return self._call("{route["path"]}", {{{body}}})')
    return "\n".join(lines)


def build_service(*, model: list[dict[str, Any]], source: str, host: str, title: str, routes_const: str, info_class: str, methods_class: str, price_range: str) -> str:
    out: list[str] = []
    out.append(f'"""Typed methods for the {host} routes ({title}).')
    out.append("")
    out.append(f"Generated by python/scripts/generate.py from {source}.")
    out.append("Do not edit by hand. Refresh the snapshot, then run `python3 python/scripts/generate.py`.")
    out.append('"""')
    out.append("")
    out.append("from __future__ import annotations")
    out.append("")
    out.append("from collections.abc import Callable, Mapping")
    out.append("from typing import Any, Literal, TypedDict")
    out.append("")
    out.append("CallRoute = Callable[[str, Mapping[str, Any]], dict[str, Any]]")
    out.append("")
    out.append("")
    out.append(f"class {info_class}(TypedDict):")
    out.append("    path: str")
    out.append("    http_method: Literal[\"GET\", \"POST\"]")
    out.append("    tool: str")
    out.append("    method: str")
    out.append("    price_usd: str")
    out.append("    amount: str")
    out.append("")
    out.append("")
    out.append(f"# Every route of https://{host} ({len(model)}), with HTTP method, MCP tool, client method and price.")
    out.append(f"{routes_const}: tuple[{info_class}, ...] = (")
    for m in model:
        out.append(
            f'    {{"path": "{m["path"]}", "http_method": "{m["http_method"]}", "tool": "{m["tool"]}", '
            f'"method": "{m["method"]}", "price_usd": "{m["price_usd"]}", "amount": "{m["amount"]}"}},'
        )
    out.append(")")
    out.append("")
    out.append("")
    out.append(f"class {methods_class}:")
    out.append(f'    """Every {host} route as a typed method. Each call costs {price_range} (paid over x402, USDC on Base)."""')
    out.append("")
    out.append("    def __init__(self, call: CallRoute) -> None:")
    out.append("        self._call = call")
    for m in model:
        out.append("")
        out.append(service_method_source(m))
    out.append("")
    return "\n".join(out)


KEYWORDS_GET = {"/v1/search-volume", "/v1/trend", "/v1/related-queries", "/v1/interest-by-region", "/v1/serp", "/v1/maps-search", "/v1/autocomplete", "/v1/bing-serp", "/v1/youtube-search"}


def build_keywords() -> str:
    model = openapi_model(
        "spec/keywords-openapi.json",
        "https://keywords.duoleads.com",
        44,
        {"12000", "18000", "24000", "30000", "40000", "45000", "48000", "80000", "160000", "210000", "250000"},
    )
    gets = {m["path"] for m in model if m["http_method"] == "GET"}
    if gets != KEYWORDS_GET:
        raise SystemExit(f"keywords GET routes changed: {sorted(gets ^ KEYWORDS_GET)}")
    return build_service(
        model=model,
        source="spec/keywords-openapi.json",
        host="keywords.duoleads.com",
        title="SEO and keyword data",
        routes_const="SEO_KEYWORD_ROUTES",
        info_class="SeoKeywordRouteInfo",
        methods_class="KeywordsMethods",
        price_range="$0.012 to $0.25",
    )


def build_social() -> str:
    model = openapi_model("spec/social-openapi.json", "https://social.duoleads.com", 26, {"10000", "20000", "25000"})
    if any(m["http_method"] != "GET" for m in model):
        raise SystemExit("every social route must be GET")
    return build_service(
        model=model,
        source="spec/social-openapi.json",
        host="social.duoleads.com",
        title="social media data",
        routes_const="SOCIAL_ROUTES",
        info_class="SocialRouteInfo",
        methods_class="SocialMethods",
        price_range="$0.01 to $0.025",
    )


# ---------------------------------------------------------------- standalone per-service packages
UMBRELLA_DIST_LINE = '_DIST = "duo-data-utilities"'
IMPORT_RE = re.compile(r"^\s*from \.([A-Za-z_][A-Za-z0-9_]*) import", re.MULTILINE)


def module_text(name: str, generated: dict[Path, str]) -> str:
    """An umbrella module's text: the fresh build for a generated one, the file on disk otherwise."""
    source = PACKAGE_DIR / name
    if source in generated:
        return generated[source]
    if not source.exists():
        raise SystemExit(f"python/duo_data_utilities/{name} does not exist")
    return source.read_text(encoding="utf-8")


def shared_closure(entry: str, generated: dict[Path, str]) -> list[str]:
    """The umbrella modules `entry` imports with `from .x import`, transitively (entry included)."""
    seen: set[str] = set()
    queue = [entry]
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        text = module_text(name, generated)
        seen.add(name)
        queue.extend(f"{m}.py" for m in IMPORT_RE.findall(text))
    return sorted(seen)


def service_package_files(generated: dict[Path, str]) -> list[tuple[Path, str]]:
    """Every generated file of the per-service packages. `generated` holds the umbrella's freshly built modules."""
    files: list[tuple[Path, str]] = []
    version_src = (PACKAGE_DIR / "_version.py").read_text(encoding="utf-8")
    if version_src.count(UMBRELLA_DIST_LINE) != 1:
        raise SystemExit(f"python/duo_data_utilities/_version.py must contain {UMBRELLA_DIST_LINE} once")
    license_text = (ROOT / "python" / "LICENSE").read_text(encoding="utf-8")
    for dist, (import_name, entry) in SERVICE_PACKAGES.items():
        pkg = SERVICE_PACKAGES_DIR / dist / import_name
        for name in shared_closure(entry, generated):
            if name == "_version.py":
                continue
            text = module_text(name, generated)
            header = f"# Copied from python/duo_data_utilities/{name} by python/scripts/generate.py. Do not edit here.\n"
            files.append((pkg / name, header + text))
        header = "# Written by python/scripts/generate.py from python/duo_data_utilities/_version.py. Do not edit here.\n"
        files.append((pkg / "_version.py", header + version_src.replace(UMBRELLA_DIST_LINE, f'_DIST = "{dist}"')))
        files.append((pkg / "py.typed", ""))
        files.append((SERVICE_PACKAGES_DIR / dist / "LICENSE", license_text))
    return files


def main() -> None:
    stale = False
    generated = {TARGET: build(), DERIVS_TARGET: build_derivs(), KEYWORDS_TARGET: build_keywords(), SOCIAL_TARGET: build_social()}
    for target, text in [*generated.items(), *service_package_files(generated)]:
        rel = target.relative_to(ROOT)
        if "--check" in sys.argv:
            current = target.read_text(encoding="utf-8") if target.exists() else ""
            if current != text:
                print(f"{rel} is stale: run python3 python/scripts/generate.py", file=sys.stderr)
                stale = True
            else:
                print(f"{rel} is up to date.")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
            print(f"wrote {rel}")
    if stale:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
