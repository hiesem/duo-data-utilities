#!/usr/bin/env node
// Generates src/generated.ts from the committed spec snapshots:
//   spec/manifest.json  (GET /v1/manifest: params, examples, output JSON Schema)
//   spec/keywords.json  (tool name and keyword-first summary per route)
//   spec/methods.json   (client namespace and method name per route)
//
// Usage: node scripts/generate.mjs          write src/generated.ts
//        node scripts/generate.mjs --check  exit 1 if src/generated.ts is stale

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
function tsType(schema, depth = 0) {
  if (schema === undefined || schema === null || schema === true) return "unknown";
  if (schema === false) return "never";
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

const text = out.join("\n");
const target = join(root, "src/generated.ts");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error("src/generated.ts is stale: run `npm run generate` and commit the result.");
    process.exit(1);
  }
  console.log(`src/generated.ts is up to date (${model.length} routes).`);
} else {
  writeFileSync(target, text);
  console.log(`wrote src/generated.ts (${model.length} routes, ${byNs.size} namespaces).`);
}
