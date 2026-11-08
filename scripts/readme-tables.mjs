#!/usr/bin/env node
// Writes the route tables into the READMEs between marker comments, from spec/route-tables.json (written by
// scripts/generate.mjs from the services' published OpenAPI). One table per marker:
//   <!-- routes:<service>:<prefix> -->  ...  <!-- /routes -->
// <service> is keywords, social or derivs; <prefix> is what precedes the method name in the README's examples
// (e.g. `keywords.` in the umbrella README, `client.` in a per-service package README).
//
// Usage: node scripts/readme-tables.mjs          rewrite the tables
//        node scripts/readme-tables.mjs --check  exit 1 if a table is stale

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tables = JSON.parse(readFileSync(join(root, "spec/route-tables.json"), "utf8"));
const files = [
  "README.md",
  "packages/x402-seo-keyword-data/README.md",
  "packages/x402-crypto-derivatives-data/README.md",
  "packages/x402-social-media-data/README.md",
];

const price = (usd) => `$${usd}`;
function table(service, prefix) {
  const rows = tables[service];
  if (!rows) throw new Error(`unknown service ${service}`);
  const out = ["| Method | Route | Price | MCP tool | What it returns |", "|---|---|---|---|---|"];
  for (const r of rows) out.push(`| \`${prefix}${r.method}\` | \`${r.httpMethod} ${r.path}\` | ${price(r.priceUsd)} | \`${r.tool}\` | ${r.summary.replace(/\|/g, "\\|")} |`);
  return out.join("\n");
}

const MARK = /<!-- routes:([a-z]+):([A-Za-z.]*) -->\n[\s\S]*?<!-- \/routes -->/g;
let stale = false;
for (const rel of files) {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  let n = 0;
  const next = text.replace(MARK, (_m, service, prefix) => {
    n++;
    return `<!-- routes:${service}:${prefix} -->\n${table(service, prefix)}\n<!-- /routes -->`;
  });
  if (n === 0) throw new Error(`${rel}: no route table marker`);
  if (process.argv.includes("--check")) {
    if (next !== text) {
      console.error(`${rel}: route table is stale: run \`node scripts/readme-tables.mjs\``);
      stale = true;
    } else console.log(`${rel}: ${n} route table(s) up to date`);
  } else {
    writeFileSync(path, next);
    console.log(`${rel}: ${n} route table(s) written`);
  }
}
if (stale) process.exit(1);
