#!/usr/bin/env node
// Writes the standalone GitHub mirror of each per-service package (github.com/hiesem/<name>):
// the package's own files plus exactly the shared ../../src files it imports (transitively), with
// imports rewritten so the tree builds and tests on its own. Output is deterministic.
//   node scripts/sync-mirrors.mjs [--out <dir>]   write the mirrors (default: .mirrors/, gitignored)
//   node scripts/sync-mirrors.mjs --check         build them in a temp dir and verify every import resolves
//                                                 inside the tree and nothing outside it is referenced
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["x402-seo-keyword-data", "x402-crypto-derivatives-data", "x402-social-media-data"];
const MONOREPO = "https://github.com/hiesem/duo-data-utilities";
const SHARED_PREFIX = "../../../src/";

const args = process.argv.slice(2);
const check = args.includes("--check");
const outArg = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : undefined;
const out = check ? mkdtempSync(join(tmpdir(), "duo-mirrors-")) : outArg ? resolve(process.cwd(), outArg) : join(ROOT, ".mirrors");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const IMPORT_RE = /\bfrom\s+"([^"]+)"/g;
const importsOf = (text) => [...text.matchAll(IMPORT_RE)].map((m) => m[1]);

/** The shared src files a package entry needs: its direct ../../../src imports plus their ./ imports. */
function sharedClosure(entryText) {
  const seen = new Set();
  const queue = importsOf(entryText).filter((s) => s.startsWith(SHARED_PREFIX)).map((s) => s.slice(SHARED_PREFIX.length));
  while (queue.length) {
    const f = queue.shift().replace(/\.js$/, ".ts");
    if (seen.has(f)) continue;
    if (!existsSync(join(ROOT, "src", f))) throw new Error(`shared file src/${f} does not exist`);
    seen.add(f);
    for (const s of importsOf(read(`src/${f}`))) if (s.startsWith("./")) queue.push(s.slice(2));
  }
  return [...seen].sort();
}

const LIB_HEADER = `// Generated from ${MONOREPO} (src/), do not edit here: change it in the monorepo and re-run scripts/sync-mirrors.mjs.\n`;

const GITIGNORE = ["node_modules/", "dist/", "coverage/", "*.tsbuildinfo", ".env", ".env.*", "*.key", "*.pem", "*.tgz", ""].join("\n");

const CI = `name: ci

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  node:
    name: Node \${{ matrix.node }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm pack --dry-run
`;

function tsconfig() {
  const rootCfg = JSON.parse(read("tsconfig.json"));
  const { paths: _paths, ...compilerOptions } = rootCfg.compilerOptions;
  return JSON.stringify({ compilerOptions, include: ["src", "test", "tsup.config.ts", "vitest.config.ts"] }, null, 2) + "\n";
}

function mirror(name) {
  const pkgDir = `packages/${name}`;
  const files = new Map();
  const entry = read(`${pkgDir}/src/index.ts`);
  const shared = sharedClosure(entry);
  files.set("src/index.ts", entry.replaceAll(`"${SHARED_PREFIX}`, `"./lib/`).replace(/\/\/ The code is bundled from the shared source in \.\.\/\.\.\/src at build time\.\n/, `// The shared client code lives in src/lib (generated from ${MONOREPO}).\n`));
  for (const f of shared) files.set(`src/lib/${f}`, LIB_HEADER + read(`src/${f}`));
  for (const t of readdirSync(join(ROOT, pkgDir, "test")).sort()) {
    const text = read(`${pkgDir}/test/${t}`);
    files.set(`test/${t}`, text.replaceAll(`"../../../src/`, `"../src/lib/`));
  }
  for (const f of ["README.md", "LICENSE", "package.json", "package-lock.json", "vitest.config.ts"]) files.set(f, read(`${pkgDir}/${f}`));
  files.set("tsup.config.ts", read(`${pkgDir}/tsup.config.ts`).replace("// Bundles the shared client code from ../../src into this package (no dependency on duo-data-utilities).", "// Bundles src/ (including the shared client code in src/lib) into dist/ (no runtime dependency on duo-data-utilities)."));
  files.set("tsconfig.json", tsconfig());
  files.set(".gitignore", GITIGNORE);
  files.set(".github/workflows/ci.yml", CI);

  // Verify: every relative import resolves inside the tree; nothing points outside it.
  for (const [path, text] of files) {
    if (!/\.ts$/.test(path)) continue;
    for (const spec of importsOf(text)) {
      if (!spec.startsWith(".")) continue;
      const target = join(dirname(path), spec).replace(/\.js$/, ".ts");
      if (target.startsWith("..")) throw new Error(`${name}: ${path} imports outside the mirror: ${spec}`);
      if (!files.has(target)) throw new Error(`${name}: ${path} imports missing ${spec}`);
    }
  }
  const dir = join(out, name);
  if (existsSync(dir)) for (const e of readdirSync(dir)) if (e !== "node_modules" && e !== "dist" && e !== ".git") rmSync(join(dir, e), { recursive: true, force: true });
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { name, dir, files: [...files.keys()].sort(), shared };
}

const results = PACKAGES.map(mirror);
for (const r of results) console.log(`${r.name}: ${r.files.length} files (shared: ${r.shared.join(", ")}) -> ${relative(process.cwd(), r.dir) || r.dir}`);
if (check) {
  rmSync(out, { recursive: true, force: true });
  console.log("sync-mirrors --check: OK (every import resolves inside each mirror)");
}
