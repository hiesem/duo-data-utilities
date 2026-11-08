#!/usr/bin/env node
// Re-fetches the published OpenAPI documents of the keyword, social and derivs services into spec/ (free pages,
// no payment). Review the diff, then run `npm run generate`. Not run by tests or builds.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const service of ["keywords", "social", "derivs"]) {
  const url = `https://${service}.duoleads.com/openapi.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const doc = await res.json();
  writeFileSync(join(root, `spec/${service}-openapi.json`), `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`spec/${service}-openapi.json: ${Object.keys(doc.paths).length} paths, version ${doc.info?.version}`);
}
