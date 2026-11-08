#!/usr/bin/env node
// Generates src/generated.ts and src/derivs-generated.ts from the committed spec snapshots:
//   spec/manifest.json        (GET /v1/manifest: params, examples, output JSON Schema)
//   spec/keywords.json        (tool name and keyword-first summary per route)
//   spec/methods.json         (client namespace and method name per route)
//   spec/derivs.json          (derivs.duoleads.com route catalogue: params, prices, output JSON Schema)
//   spec/derivs-methods.json  (derivs client method name and numeric parameters per route)
//
// Usage: node scripts/generate.mjs          write both files
//        node scripts/generate.mjs --check  exit 1 if either file is stale

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const manifest = readJson("spec/manifest.json");
const keywords = readJson("spec/keywords.json");
const methods = readJson("spec/methods.json");

// ---------------------------------------------------------------- validate the snapshots
if (!manifest.ok || manifest.route !== "/v1/manifest") throw new Error("spec/manifest.json is not a /v1/manifest envelope");
const routes = manifest.data.routes;
if (routes.length !== 33) throw new Error(`manifest has ${routes.length} routes, expected 33`);
const paths = routes.map((r) => r.path);
if (new Set(paths).size !== paths.length) throw new Error("duplicate route paths in manifest");
const sameSet = (a, b, what) => {
  const missing = [...a].filter((x) => !b.has(x));
  const extra = [...b].filter((x) => !a.has(x));
  if (missing.length || extra.length) throw new Error(`${what}: missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
};
sameSet(new Set(paths), new Set(Object.keys(keywords.routes)), "spec/keywords.json routes");
sameSet(new Set(paths), new Set(Object.keys(methods.routes)), "spec/methods.json routes");
const methodIds = Object.values(methods.routes).map((m) => `${m.namespace}.${m.method}`);
if (new Set(methodIds).size !== methodIds.length) throw new Error("duplicate namespace.method names in spec/methods.json");

// ---------------------------------------------------------------- helpers
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sanitize = (text) => String(text).replace(/\s+/g, " ").replace(/\*\//g, "*\\/").trim();
const sentence = (text) => {
  const t = sanitize(text).replace(/\.+$/, "");
  return `${t}.`;
};
const propKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const literal = (v) => (v === null || ["string", "number", "boolean"].includes(typeof v) ? JSON.stringify(v) : "unknown");
const unionOf = (parts) => {
  const uniq = [...new Set(parts)];
  if (uniq.includes("unknown")) return "unknown";
  return uniq.join(" | ");
};
const wrapForArray = (t) => (t.includes(" | ") ? `(${t})` : t);

// JSON Schema (draft 2020-12 subset used by output_schema) to TypeScript.
let refPrefix = null; // set while emitting an OpenAPI service: #/components/schemas/X -> <prefix>X
const refName = (ref) => {
  const name = String(ref).replace(/^#\/components\/schemas\//, "");
  return name.startsWith(refPrefix) ? name : `${refPrefix}${name}`;
};
function tsType(schema, depth = 0) {
  if (schema === undefined || schema === null || schema === true) return "unknown";
  if (schema === false) return "never";
  if (typeof schema.$ref === "string") {
    if (refPrefix === null) return "unknown";
    return refName(schema.$ref);
  }
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return unionOf(schema.enum.map(literal));
  if (Array.isArray(schema.anyOf)) return unionOf(schema.anyOf.map((s) => tsType(s, depth)));
  if (Array.isArray(schema.oneOf)) return unionOf(schema.oneOf.map((s) => tsType(s, depth)));
  let types;
  if (schema.type !== undefined) types = Array.isArray(schema.type) ? schema.type : [schema.type];
  else if (schema.properties) types = ["object"];
  else if (schema.items) types = ["array"];
  else types = [];
  if (types.length === 0) return "unknown";
  return unionOf(
    types.map((t) => {
      switch (t) {
        case "string":
          return "string";
        case "integer":
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return arrayType(schema, depth);
        case "object":
          return objectType(schema, depth);
        default:
          return "unknown";
      }
    }),
  );
}

function arrayType(schema, depth) {
  if (Array.isArray(schema.items)) return `[${schema.items.map((s) => tsType(s, depth)).join(", ")}]`;
  if (schema.items === undefined) return "unknown[]";
  return `${wrapForArray(tsType(schema.items, depth))}[]`;
}

function objectType(schema, depth) {
  const props = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  const ap = schema.additionalProperties;
  if (props.length === 0) {
    if (ap === undefined || ap === true) return "Record<string, unknown>";
    if (ap === false) return "Record<string, never>";
    return `Record<string, ${tsType(ap, depth + 1)}>`;
  }
  const pad = "  ".repeat(depth + 1);
  const lines = props.map(([k, v]) => {
    const doc = v && typeof v === "object" && v.description ? `${pad}/** ${sanitize(v.description)} */\n` : "";
    return `${doc}${pad}${propKey(k)}${required.has(k) ? "" : "?"}: ${tsType(v, depth + 1)};`;
  });
  if (ap !== undefined && ap !== false) lines.push(`${pad}[key: string]: ${ap === true ? "unknown" : tsType(ap, depth + 1)};`);
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

// Request parameter to TypeScript. Booleans are sent as "true"/"false" on the query string.
function paramType(p) {
  if (p.kind === "boolean") return "boolean";
  if (p.kind === "integer" || p.kind === "number") return "number";
  if (Array.isArray(p.enum) && p.enum.length > 0) return p.enum.map((v) => JSON.stringify(String(v))).join(" | ");
  return "string";
}

function paramDoc(p) {
  const parts = [sanitize(p.description)];
  if (p.expected) parts.push(`Expected: ${sentence(p.expected)}`);
  if (p.default !== undefined) parts.push(`Default: ${JSON.stringify(p.default)}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------- per-route model
const model = routes.map((r) => {
  const kw = keywords.routes[r.path];
  const m = methods.routes[r.path];
  const Base = cap(m.namespace) + cap(m.method);
  return {
    path: r.path,
    tool: kw.tool,
    summary: kw.summary,
    priceUsd: r.price_usd,
    namespace: m.namespace,
    method: m.method,
    Base,
    params: r.params,
    dataSchema: r.output_schema?.properties?.data ?? null,
  };
});
const typeNames = model.flatMap((m) => [`${m.Base}Params`, `${m.Base}Data`]);
if (new Set(typeNames).size !== typeNames.length) throw new Error("generated type names collide");

// ---------------------------------------------------------------- emit
const out = [];
out.push("// Generated by scripts/generate.mjs from spec/manifest.json, spec/keywords.json and spec/methods.json.");
out.push("// Do not edit by hand. Refresh the snapshots, then run `npm run generate`.");
out.push("");
out.push('import type { CallRoute } from "./caller.js";');
out.push("");
out.push("/** Every route in the manifest snapshot. */");
out.push("export const ROUTES = [");
for (const m of model) {
  out.push(
    `  { path: ${JSON.stringify(m.path)}, tool: ${JSON.stringify(m.tool)}, namespace: ${JSON.stringify(m.namespace)}, method: ${JSON.stringify(m.method)}, priceUsd: ${JSON.stringify(m.priceUsd)} },`,
  );
}
out.push("] as const;");
out.push("");
out.push("/** A route path such as `/v1/id/iban`. */");
out.push('export type RoutePath = (typeof ROUTES)[number]["path"];');
out.push("");

for (const m of model) {
  out.push(`/** Query parameters for \`GET ${m.path}\`. */`);
  if (m.params.length === 0) {
    out.push(`export type ${m.Base}Params = Record<string, never>;`);
  } else {
    out.push(`export interface ${m.Base}Params {`);
    for (const p of m.params) {
      out.push(`  /** ${paramDoc(p)} */`);
      out.push(`  ${propKey(p.name)}${p.required ? "" : "?"}: ${paramType(p)};`);
    }
    out.push("}");
  }
  out.push("");
  out.push(`/** The \`data\` object returned by \`GET ${m.path}\` (from the route's output schema). */`);
  out.push(`export type ${m.Base}Data = ${m.dataSchema ? tsType(m.dataSchema) : "unknown"};`);
  out.push("");
}

out.push("/** Typed methods, grouped by namespace. Each one costs $0.05 (paid over x402). */");
out.push("export interface GeneratedClient {");
const byNs = new Map();
for (const m of model) {
  if (!byNs.has(m.namespace)) byNs.set(m.namespace, []);
  byNs.get(m.namespace).push(m);
}
for (const [ns, list] of byNs) {
  out.push(`  ${propKey(ns)}: {`);
  for (const m of list) {
    out.push("    /**");
    out.push(`     * ${sentence(m.summary)} Costs $${m.priceUsd} per call.`);
    out.push("     *");
    out.push(`     * Route: \`GET ${m.path}\``);
    out.push("     */");
    out.push(`    ${m.method}(params: ${m.Base}Params): Promise<${m.Base}Data>;`);
  }
  out.push("  };");
}
out.push("}");
out.push("");
out.push("/** Binds every generated method to one route caller. */");
out.push("export function createGeneratedClient(call: CallRoute): GeneratedClient {");
out.push("  return {");
for (const [ns, list] of byNs) {
  out.push(`    ${propKey(ns)}: {`);
  for (const m of list) {
    out.push(
      `      ${m.method}: (params: ${m.Base}Params) => call<${m.Base}Data>(${JSON.stringify(m.path)}, params),`,
    );
  }
  out.push("    },");
}
out.push("  };");
out.push("}");
out.push("");

// ---------------------------------------------------------------- derivs.duoleads.com
// The derivs catalogue comes from the service's published OpenAPI (spec/derivs-openapi.json); spec/derivs.json
// (the older export the Python generator reads) is only cross-checked against it: same paths, tools and prices.
const derivsLegacy = readJson("spec/derivs.json");
const derivs = derivsFromOpenApi(readJson("spec/derivs-openapi.json"));
{
  const key = (r) => `${r.path} ${r.tool} ${r.amount}`;
  sameSet(new Set(derivsLegacy.routes.map(key)), new Set(derivs.routes.map(key)), "spec/derivs.json vs spec/derivs-openapi.json (path, tool, amount)");
}
function derivsFromOpenApi(spec) {
  const schemas = spec.components?.schemas ?? {};
  const inline = (v) => {
    if (Array.isArray(v)) return v.map(inline);
    if (!v || typeof v !== "object") return v;
    if (typeof v.$ref === "string") return inline(schemas[v.$ref.replace(/^#\/components\/schemas\//, "")]);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inline(x)]));
  };
  return {
    origin: spec.servers?.[0]?.url,
    routes: Object.entries(spec.paths).map(([path, ops]) => {
      const op = ops.get;
      if (!op) throw new Error(`derivs ${path}: not GET`);
      const query = (op.parameters ?? []).filter((p) => p.in === "query");
      return {
        path,
        tool: op["x-mcp-tool"],
        amount: String(Math.round(Number(op["x-payment-info"].price.amount) * 1e6)),
        description: op.description,
        querySchema: {
          properties: Object.fromEntries(query.map((p) => [p.name, { ...p.schema, description: p.description }])),
          required: query.filter((p) => p.required).map((p) => p.name),
        },
        outputSchema: inline(op.responses["200"].content["application/json"].schema),
      };
    }),
  };
}
const derivsMethods = readJson("spec/derivs-methods.json").routes;
if (derivs.origin !== "https://derivs.duoleads.com") throw new Error("spec/derivs.json: unexpected origin");
if (derivs.routes.length !== 10) throw new Error(`spec/derivs.json has ${derivs.routes.length} routes, expected 10`);
sameSet(new Set(derivs.routes.map((r) => r.path)), new Set(Object.keys(derivsMethods)), "spec/derivs-methods.json routes");
const usd = (amount) => (Number(amount) / 1e6).toString();

const dmodel = derivs.routes.map((r) => {
  const m = derivsMethods[r.path];
  if (!/^\/v1\/[a-z0-9-]+$/.test(r.path)) throw new Error(`derivs path ${r.path} has an unexpected shape`);
  if (!["3000", "5000"].includes(r.amount)) throw new Error(`derivs ${r.path}: unexpected amount ${r.amount}`);
  const numeric = new Set([...m.integers, ...m.numbers]);
  for (const name of numeric) if (!(name in r.querySchema.properties)) throw new Error(`derivs ${r.path}: unknown numeric parameter ${name}`);
  const required = new Set(r.querySchema.required);
  const params = Object.entries(r.querySchema.properties).map(([name, schema]) => ({
    name,
    required: required.has(name),
    description: schema.description ?? "",
    default: schema.default,
    type: Array.isArray(schema.enum) ? schema.enum.map((v) => JSON.stringify(String(v))).join(" | ") : numeric.has(name) ? "number | string" : "string",
  }));
  return { ...r, method: m.method, Base: cap(m.method), params };
});

const dout = [];
dout.push("// Generated by scripts/generate.mjs from spec/derivs.json and spec/derivs-methods.json.");
dout.push("// Do not edit by hand. Refresh the snapshot, then run `npm run generate`.");
dout.push("");
dout.push('import type { CallRoute } from "./caller.js";');
dout.push("");
dout.push("/** Every route of https://derivs.duoleads.com, with its price in USD and in atomic USDC (6 decimals). */");
dout.push("export const DERIVS_ROUTES = [");
for (const m of dmodel) {
  dout.push(
    `  { path: ${JSON.stringify(m.path)}, tool: ${JSON.stringify(m.tool)}, method: ${JSON.stringify(m.method)}, priceUsd: ${JSON.stringify(usd(m.amount))}, amount: ${JSON.stringify(m.amount)} },`,
  );
}
dout.push("] as const;");
dout.push("");
dout.push("/** A derivs route path such as `/v1/funding-rates`. */");
dout.push('export type DerivsRoutePath = (typeof DERIVS_ROUTES)[number]["path"];');
dout.push("");
for (const m of dmodel) {
  dout.push(`/** Query parameters for \`GET ${m.path}\` on derivs.duoleads.com. */`);
  if (m.params.length === 0) {
    dout.push(`export type Derivs${m.Base}Params = Record<string, never>;`);
  } else {
    dout.push(`export interface Derivs${m.Base}Params {`);
    for (const p of m.params) {
      dout.push(`  /** ${sanitize(p.description)}${p.default !== undefined && !/Default/.test(p.description) ? ` Default: ${JSON.stringify(p.default)}.` : ""} */`);
      dout.push(`  ${propKey(p.name)}${p.required ? "" : "?"}: ${p.type};`);
    }
    dout.push("}");
  }
  dout.push("");
  dout.push(`/** The JSON body returned by \`GET ${m.path}\` (from the route's response schema). */`);
  dout.push(`export type Derivs${m.Base}Data = ${tsType({ ...m.outputSchema, $schema: undefined, title: undefined })};`);
  dout.push("");
}
dout.push("/** Typed methods for the derivs.duoleads.com routes. Each one is paid per call over x402 (USDC on Base). */");
dout.push("export interface DerivsGeneratedClient {");
for (const m of dmodel) {
  dout.push("  /**");
  dout.push(`   * ${sentence(m.description)}`);
  dout.push("   *");
  dout.push(`   * Route: \`GET ${m.path}\`. Costs $${usd(m.amount)} per call (${m.amount} atomic USDC). MCP tool: \`${m.tool}\`.`);
  dout.push("   */");
  const optional = m.params.every((p) => !p.required);
  dout.push(`  ${m.method}(params${optional ? "?" : ""}: Derivs${m.Base}Params): Promise<Derivs${m.Base}Data>;`);
}
dout.push("}");
dout.push("");
dout.push("/** Binds every derivs method to one route caller. */");
dout.push("export function createDerivsGeneratedClient(call: CallRoute): DerivsGeneratedClient {");
dout.push("  return {");
for (const m of dmodel) {
  const optional = m.params.every((p) => !p.required);
  dout.push(`    ${m.method}: (params${optional ? "?" : ""}: Derivs${m.Base}Params) => call<Derivs${m.Base}Data>(${JSON.stringify(m.path)}, params ?? {}),`);
}
dout.push("  };");
dout.push("}");
dout.push("");

// ---------------------------------------------------------------- OpenAPI services (keywords.duoleads.com, social.duoleads.com)
// Input: the free, published /openapi.json of each service (spec/<service>-openapi.json, fetched by
// scripts/refresh-specs.mjs). Every route's path, HTTP method, MCP tool, price, parameters and answer schema
// come from it; method names are the path in camelCase (/v1/keyword-gap -> keywordGap, /v1/x/search -> xSearch).
const camelPath = (path) =>
  path
    .replace(/^\/v1\//, "")
    .split(/[/-]/)
    .map((w, i) => (i === 0 ? w : cap(w)))
    .join("");

function openApiModel(spec, { origin, count, amounts }) {
  if (spec.servers?.[0]?.url !== origin) throw new Error(`${origin}: unexpected servers[0].url ${spec.servers?.[0]?.url}`);
  const entries = Object.entries(spec.paths);
  if (entries.length !== count) throw new Error(`${origin}: ${entries.length} paths, expected ${count}`);
  const schemas = spec.components?.schemas ?? {};
  const deref = (s) => (s && typeof s.$ref === "string" ? schemas[s.$ref.replace(/^#\/components\/schemas\//, "")] : s);
  const model = entries.map(([path, ops]) => {
    if (!/^\/v1\/[a-z0-9]+(\/[a-z0-9-]+|-[a-z0-9-]+)*$/.test(path)) throw new Error(`${origin}${path}: unexpected path shape`);
    const httpMethod = ops.get ? "GET" : ops.post ? "POST" : null;
    if (!httpMethod) throw new Error(`${origin}${path}: neither GET nor POST`);
    const op = ops[httpMethod.toLowerCase()];
    const priceUsd = op["x-payment-info"]?.price?.amount;
    if (typeof priceUsd !== "string" || !/^\d+(\.\d+)?$/.test(priceUsd)) throw new Error(`${origin}${path}: no fixed price`);
    const amount = String(Math.round(Number(priceUsd) * 1e6));
    if (!amounts.includes(amount)) throw new Error(`${origin}${path}: unexpected amount ${amount}`);
    if (typeof op["x-mcp-tool"] !== "string") throw new Error(`${origin}${path}: no x-mcp-tool`);
    let params;
    if (httpMethod === "GET") {
      params = (op.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => {
          const sch = p.schema ?? {};
          let type = "string";
          if (Array.isArray(sch.enum) && sch.enum.length) type = sch.enum.map((v) => JSON.stringify(String(v))).join(" | ");
          else if (sch.type === "integer" || sch.type === "number") type = "number";
          else if (sch.type === "boolean") type = "boolean";
          else if (typeof sch.pattern === "string" && /^\^0\*\(/.test(sch.pattern)) type = "number | string";
          return { name: p.name, required: p.required === true, description: p.description ?? "", default: sch.default, type };
        });
    } else {
      const body = deref(op.requestBody?.content?.["application/json"]?.schema) ?? { properties: {} };
      const required = new Set(body.required ?? []);
      params = Object.entries(body.properties ?? {}).map(([name, sch]) => ({
        name,
        required: required.has(name),
        description: sch.description ?? "",
        default: sch.default,
        type: tsType({ ...sch, description: undefined }),
      }));
    }
    const ok = op.responses?.["200"]?.content?.["application/json"]?.schema;
    if (!ok) throw new Error(`${origin}${path}: no 200 schema`);
    return { path, httpMethod, tool: op["x-mcp-tool"], summary: op.summary ?? "", description: op.description ?? "", priceUsd, amount, method: camelPath(path), Base: cap(camelPath(path)), params, ok };
  });
  const names = model.map((m) => m.method);
  if (new Set(names).size !== names.length) throw new Error(`${origin}: method names collide`);
  return { model, schemas };
}

/** Emits one service file. `skip`: paths that get route-table entries but no generated method (hand-written ones). */
function emitService({ spec, origin, count, amounts, prefix, routesConst, routesDoc, iface, factory, file, skip = new Set(), host }) {
  refPrefix = prefix;
  const { model, schemas } = openApiModel(spec, { origin, count, amounts });
  const gen = model.filter((m) => !skip.has(m.path));
  const o = [];
  o.push(`// Generated by scripts/generate.mjs from ${file}. Do not edit by hand.`);
  o.push("// Refresh the snapshot (`node scripts/refresh-specs.mjs`), review the diff, then run `npm run generate`.");
  o.push("");
  o.push('import type { CallRoute } from "./caller.js";');
  o.push("");
  o.push(`/** ${routesDoc} */`);
  o.push(`export const ${routesConst} = [`);
  for (const m of model) {
    o.push(`  { path: ${JSON.stringify(m.path)}, httpMethod: ${JSON.stringify(m.httpMethod)}, tool: ${JSON.stringify(m.tool)}, method: ${JSON.stringify(m.method)}, priceUsd: ${JSON.stringify(m.priceUsd)}, amount: ${JSON.stringify(m.amount)} },`);
  }
  o.push("] as const;");
  o.push("");
  // Named answer types: every component schema a generated route's answer refers to (transitively).
  const used = new Set();
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    if (typeof v.$ref === "string") {
      const n = v.$ref.replace(/^#\/components\/schemas\//, "");
      if (!used.has(n)) {
        used.add(n);
        visit(schemas[n]);
      }
    }
    for (const x of Object.values(v)) visit(x);
  };
  gen.forEach((m) => visit(m.ok));
  for (const n of [...used].sort()) {
    const sch = schemas[n];
    if (!sch) throw new Error(`${origin}: missing component ${n}`);
    if (sch.description) o.push(`/** ${sanitize(sch.description)} */`);
    o.push(`export type ${refName(`#/components/schemas/${n}`)} = ${tsType({ ...sch, description: undefined, title: undefined })};`);
    o.push("");
  }
  for (const m of gen) {
    const where = m.httpMethod === "GET" ? "Query parameters" : "JSON body";
    o.push(`/** ${where} for \`${m.httpMethod} ${m.path}\` on ${host}. */`);
    if (m.params.length === 0) o.push(`export type ${prefix}${m.Base}Params = Record<string, never>;`);
    else {
      o.push(`export interface ${prefix}${m.Base}Params {`);
      for (const p of m.params) {
        const def = p.default !== undefined && !/Default/.test(p.description) ? ` Default: ${JSON.stringify(p.default)}.` : "";
        if (p.description || def) o.push(`  /** ${sanitize(p.description)}${def} */`);
        o.push(`  ${propKey(p.name)}${p.required ? "" : "?"}: ${p.type};`);
      }
      o.push("}");
    }
    o.push("");
    o.push(`/** The JSON body returned by \`${m.httpMethod} ${m.path}\` (from the route's response schema). */`);
    o.push(`export type ${prefix}${m.Base}Data = ${tsType(m.ok)};`);
    o.push("");
  }
  o.push(`/** Typed methods for the ${host} routes. Each one is paid per call over x402 (USDC on Base). */`);
  o.push(`export interface ${iface} {`);
  for (const m of gen) {
    o.push("  /**");
    o.push(`   * ${sentence(m.description)}`);
    o.push("   *");
    o.push(`   * Route: \`${m.httpMethod} ${m.path}\`. Costs $${m.priceUsd} per call (${m.amount} atomic USDC). MCP tool: \`${m.tool}\`.`);
    o.push("   */");
    const optional = m.params.every((p) => !p.required);
    o.push(`  ${m.method}(params${optional ? "?" : ""}: ${prefix}${m.Base}Params): Promise<${prefix}${m.Base}Data>;`);
  }
  o.push("}");
  o.push("");
  o.push(`/** Binds every generated ${host} method to one route caller. */`);
  o.push(`export function ${factory}(call: CallRoute): ${iface} {`);
  o.push("  return {");
  for (const m of gen) {
    const optional = m.params.every((p) => !p.required);
    o.push(`    ${m.method}: (params${optional ? "?" : ""}: ${prefix}${m.Base}Params) => call<${prefix}${m.Base}Data>(${JSON.stringify(m.path)}, params ?? {}),`);
  }
  o.push("  };");
  o.push("}");
  o.push("");
  refPrefix = null;
  return { text: o.join("\n"), model, gen };
}

const KW_V1 = new Set(["/v1/keyword-overview", "/v1/search-volume", "/v1/keyword-ideas", "/v1/trend", "/v1/related-queries", "/v1/interest-by-region"]);
const seo = emitService({
  spec: readJson("spec/keywords-openapi.json"),
  origin: "https://keywords.duoleads.com",
  count: 44,
  amounts: ["12000", "18000", "24000", "30000", "40000", "45000", "48000", "80000", "160000", "210000", "250000"],
  prefix: "Seo",
  routesConst: "SEO_KEYWORD_ROUTES",
  routesDoc: "Every route of https://keywords.duoleads.com (44), with HTTP method, MCP tool, client method and price (USD and atomic USDC).",
  iface: "SeoKeywordGeneratedClient",
  factory: "createSeoKeywordGeneratedClient",
  file: "spec/keywords-openapi.json",
  skip: KW_V1,
  host: "keywords.duoleads.com",
});
const social = emitService({
  spec: readJson("spec/social-openapi.json"),
  origin: "https://social.duoleads.com",
  count: 26,
  amounts: ["10000", "20000", "25000"],
  prefix: "Social",
  routesConst: "SOCIAL_ROUTES",
  routesDoc: "Every route of https://social.duoleads.com (26), with HTTP method, MCP tool, client method and price (USD and atomic USDC).",
  iface: "SocialGeneratedClient",
  factory: "createSocialGeneratedClient",
  file: "spec/social-openapi.json",
  host: "social.duoleads.com",
});
for (const m of seo.model) if (KW_V1.has(m.path) !== true && m.httpMethod === "GET" && !["/v1/serp", "/v1/maps-search", "/v1/autocomplete", "/v1/bing-serp", "/v1/youtube-search"].includes(m.path)) throw new Error(`unexpected GET route ${m.path}`);
for (const m of social.model) if (m.httpMethod !== "GET") throw new Error(`social ${m.path} is not GET`);

// The same model, as data for the README route tables (scripts/readme-tables.mjs reads it).
const routeTables = {
  keywords: seo.model.map(({ path, httpMethod, tool, method, priceUsd, summary }) => ({ path, httpMethod, tool, method, priceUsd, summary })),
  social: social.model.map(({ path, httpMethod, tool, method, priceUsd, summary }) => ({ path, httpMethod, tool, method, priceUsd, summary })),
  derivs: Object.entries(readJson("spec/derivs-openapi.json").paths).map(([path, ops]) => ({
    path,
    httpMethod: "GET",
    tool: ops.get["x-mcp-tool"],
    method: derivsMethods[path].method,
    priceUsd: ops.get["x-payment-info"].price.amount,
    summary: ops.get.summary ?? "",
  })),
};

// ---------------------------------------------------------------- write or check
const targets = [
  ["src/generated.ts", out.join("\n"), `${model.length} routes, ${byNs.size} namespaces`],
  ["src/derivs-generated.ts", dout.join("\n"), `${dmodel.length} derivs routes`],
  ["src/seo-generated.ts", seo.text, `${seo.model.length} keyword routes, ${seo.gen.length} generated methods`],
  ["src/social-generated.ts", social.text, `${social.model.length} social routes`],
  ["spec/route-tables.json", `${JSON.stringify(routeTables, null, 1)}\n`, "README route tables"],
];
let stale = false;
for (const [rel, text, what] of targets) {
  const target = join(root, rel);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      console.error(`${rel} is stale: run \`npm run generate\` and commit the result.`);
      stale = true;
    } else {
      console.log(`${rel} is up to date (${what}).`);
    }
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${rel} (${what}).`);
  }
}
if (stale) process.exit(1);
