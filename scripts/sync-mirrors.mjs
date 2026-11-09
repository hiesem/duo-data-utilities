#!/usr/bin/env node
// Writes the standalone GitHub mirror of each per-service package (github.com/hiesem/<name>):
// the package's own files plus exactly the shared ../../src files it imports (transitively), with
// imports rewritten so the tree builds and tests on its own. Output is deterministic.
//   node scripts/sync-mirrors.mjs [--out <dir>]   write the mirrors (default: .mirrors/, gitignored)
//   node scripts/sync-mirrors.mjs --check         build them in a temp dir and verify every import resolves
//                                                 inside the tree and nothing outside it is referenced
//   node scripts/sync-mirrors.mjs --commit [--out <dir>] [--allow-dirty]
//       write the mirrors, scan every tree with the main repo's scripts/check-secrets.sh --tree (exit 1
//       on a hit, before any git call), then commit each changed mirror (an existing git repo) as
//       hiesem <4965927+hiesem@users.noreply.github.com>, naming the package version and this repo's
//       HEAD. Refused while this repo has uncommitted changes, unless --allow-dirty (the message then
//       says so). Never pushes: pushing stays a separate, explicit step.
//   node scripts/sync-mirrors.mjs --verify-remote [--no-mirrors] [--no-npm] [--remote-base <url>]
//                                  [--npm-from <dir>] [--local-from <dir>]
//       1. clones each mirror (depth 1, from <remote-base>/<name>.git, default https://github.com/hiesem)
//          and diffs it with a fresh generation;
//       2. after a publish: `npm pack <name>@<version>` from the registry for all four packages, and a local
//          `npm pack` (this runs the build), and diffs package.json and dist/ of the two tarballs.
//          --npm-from / --local-from take <name>-<version>.tgz files from a directory instead (tests, offline).
//       Exit 1 on any difference, printing one line per differing path.
// The scanner reads the secret values without printing them; set CHECK_SECRETS to use another scanner path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["x402-seo-keyword-data", "x402-crypto-derivatives-data", "x402-social-media-data"];
const MONOREPO = "https://github.com/hiesem/duo-data-utilities";
const SHARED_PREFIX = "../../../src/";

const MIRROR_IDENTITY = { name: "hiesem", email: "4965927+hiesem@users.noreply.github.com" };
const UMBRELLA = "duo-data-utilities";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} needs a value`);
  return value;
};
function usage(message) {
  console.error(`sync-mirrors: ${message}`);
  process.exit(2);
}
const KNOWN = new Set(["--check", "--out", "--commit", "--allow-dirty", "--verify-remote", "--no-mirrors", "--no-npm", "--remote-base", "--npm-from", "--local-from"]);
for (const [i, a] of args.entries()) if (a.startsWith("--") && !KNOWN.has(a)) usage(`unknown option ${a}`);
else if (!a.startsWith("--") && !["--out", "--remote-base", "--npm-from", "--local-from"].includes(args[i - 1])) usage(`unexpected argument ${a}`);
const check = flag("--check");
const commit = flag("--commit");
const verifyRemote = flag("--verify-remote");
if ([check, commit, verifyRemote].filter(Boolean).length > 1) usage("--check, --commit and --verify-remote are separate modes");
const outArg = option("--out");
const out = check || verifyRemote ? mkdtempSync(join(tmpdir(), "duo-mirrors-")) : outArg ? resolve(process.cwd(), outArg) : join(ROOT, ".mirrors");

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

/** Runs a command and returns its stdout; throws (exit 1 below) with its stderr when it fails. */
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed${r.stderr ? `:\n${r.stderr.trim()}` : ""}`);
  return r.stdout;
}

/** Every file under dir (relative paths, sorted), skipping .git. */
function walk(dir, prefix = "") {
  const found = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.name === ".git") continue;
    if (e.isDirectory()) found.push(...walk(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

/** One line per path that differs between two file maps (path -> Buffer). */
function diffFiles(label, a, b, nameA, nameB) {
  const lines = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!b.has(path)) lines.push(`${label}: ${path} only in ${nameA}`);
    else if (!a.has(path)) lines.push(`${label}: ${path} only in ${nameB}`);
    else if (!a.get(path).equals(b.get(path))) lines.push(`${label}: ${path} differs`);
  }
  return lines;
}

const sourceVersion = (name) => JSON.parse(read(name === UMBRELLA ? "package.json" : `packages/${name}/package.json`)).version;

function commitMirrors(results) {
  // 1. Scan every generated tree first: a hit stops the run before any git call.
  const scanner = process.env.CHECK_SECRETS ?? join(ROOT, "..", "scripts", "check-secrets.sh");
  if (!existsSync(scanner)) {
    console.error(`sync-mirrors --commit: secret scanner not found at ${scanner}; refusing to commit unscanned trees`);
    process.exit(1);
  }
  for (const r of results) {
    if (!existsSync(join(r.dir, ".git"))) {
      console.error(`sync-mirrors --commit: ${r.dir} is not a git repository (git init -b main and add its origin first)`);
      process.exit(1);
    }
  }
  let leak = false;
  for (const r of results) {
    const scan = spawnSync("bash", [scanner, "--tree", r.dir], { encoding: "utf8" });
    process.stdout.write(`${r.name}: ${scan.stdout}`);
    if (scan.status !== 0) {
      leak = true;
      if (scan.stderr) process.stderr.write(scan.stderr);
    }
  }
  if (leak) {
    console.error("sync-mirrors --commit: the secret scan failed; nothing was committed");
    process.exit(1);
  }
  // 2. Commit with the noreply identity, never the machine's git identity.
  const dirty = run("git", ["-C", ROOT, "status", "--porcelain"]).trim() !== "";
  if (dirty && !flag("--allow-dirty")) {
    console.error("sync-mirrors --commit: this repo has uncommitted changes; commit them first (or pass --allow-dirty)");
    process.exit(1);
  }
  const sha = run("git", ["-C", ROOT, "rev-parse", "HEAD"]).trim();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: MIRROR_IDENTITY.name,
    GIT_AUTHOR_EMAIL: MIRROR_IDENTITY.email,
    GIT_COMMITTER_NAME: MIRROR_IDENTITY.name,
    GIT_COMMITTER_EMAIL: MIRROR_IDENTITY.email,
  };
  for (const r of results) {
    run("git", ["-C", r.dir, "add", "-A"], { env });
    const staged = spawnSync("git", ["-C", r.dir, "diff", "--cached", "--quiet"], { env });
    if (staged.status === 0) {
      console.log(`${r.name}: up to date, nothing to commit`);
      continue;
    }
    const message = `Mirror of ${r.name} ${sourceVersion(r.name)} from hiesem/duo-data-utilities ${sha}${dirty ? " (with uncommitted changes)" : ""}`;
    run("git", ["-C", r.dir, "commit", "-q", "-m", message], { env, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`${r.name}: committed "${message}" (not pushed)`);
  }
}

/** The mirrors on the remote, each against a fresh generation. */
function verifyMirrors(results) {
  const base = (option("--remote-base") ?? "https://github.com/hiesem").replace(/\/+$/, "");
  const lines = [];
  const clones = mkdtempSync(join(tmpdir(), "duo-mirror-clones-"));
  try {
    for (const r of results) {
      const dir = join(clones, r.name);
      run("git", ["clone", "-q", "--depth", "1", `${base}/${r.name}.git`, dir]);
      const remote = new Map(run("git", ["-C", dir, "ls-files", "-z"]).split("\0").filter(Boolean).map((p) => [p, readFileSync(join(dir, p))]));
      const local = new Map(r.files.map((p) => [p, readFileSync(join(r.dir, p))]));
      lines.push(...diffFiles(`${r.name} (mirror)`, local, remote, "the fresh generation", "the remote"));
    }
  } finally {
    rmSync(clones, { recursive: true, force: true });
  }
  return lines;
}

/** package.json and dist/ of the registry tarball against a local `npm pack`, for all four packages. */
function verifyNpm() {
  const lines = [];
  const work = mkdtempSync(join(tmpdir(), "duo-npm-verify-"));
  const fromDir = (dirArg, name, version) => {
    const file = join(resolve(process.cwd(), dirArg), `${name}-${version}.tgz`);
    if (!existsSync(file)) throw new Error(`${file} not found`);
    return file;
  };
  const packed = (json, dest) => join(dest, JSON.parse(json)[0].filename);
  const unpack = (tgz, dest) => {
    mkdirSync(dest, { recursive: true });
    run("tar", ["-xzf", tgz, "-C", dest]);
    const pkg = join(dest, "package");
    const files = new Map();
    if (existsSync(join(pkg, "package.json"))) files.set("package.json", readFileSync(join(pkg, "package.json")));
    if (existsSync(join(pkg, "dist"))) for (const f of walk(join(pkg, "dist"))) files.set(`dist/${f}`, readFileSync(join(pkg, "dist", f)));
    return files;
  };
  try {
    for (const name of [UMBRELLA, ...PACKAGES]) {
      const version = sourceVersion(name);
      const dest = join(work, name);
      mkdirSync(dest, { recursive: true });
      const registryTgz = option("--npm-from")
        ? fromDir(option("--npm-from"), name, version)
        : packed(run("npm", ["pack", `${name}@${version}`, "--json", "--pack-destination", dest], { cwd: work }), dest);
      const localTgz = option("--local-from")
        ? fromDir(option("--local-from"), name, version)
        : packed(run("npm", ["pack", "--json", "--pack-destination", dest], { cwd: name === UMBRELLA ? ROOT : join(ROOT, "packages", name) }), dest);
      const registry = unpack(registryTgz, join(dest, "registry"));
      const local = unpack(localTgz, join(dest, "local"));
      if (!local.has("package.json")) lines.push(`${name}@${version} (npm): the local tarball has no package.json`);
      lines.push(...diffFiles(`${name}@${version} (npm)`, local, registry, "the local pack", "the registry"));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return lines;
}

const results = PACKAGES.map(mirror);
if (!verifyRemote) for (const r of results) console.log(`${r.name}: ${r.files.length} files (shared: ${r.shared.join(", ")}) -> ${relative(process.cwd(), r.dir) || r.dir}`);
if (check) {
  rmSync(out, { recursive: true, force: true });
  console.log("sync-mirrors --check: OK (every import resolves inside each mirror)");
}
try {
  if (commit) commitMirrors(results);
} catch (error) {
  console.error(`sync-mirrors --commit: ${error.message}`);
  process.exit(1);
}
if (verifyRemote) {
  const lines = [];
  try {
    if (!flag("--no-mirrors")) lines.push(...verifyMirrors(results));
    if (!flag("--no-npm")) lines.push(...verifyNpm());
  } catch (error) {
    console.error(`sync-mirrors --verify-remote: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  if (process.exitCode === 1) process.exit(1);
  for (const line of lines) console.log(line);
  if (lines.length > 0) {
    console.error(`sync-mirrors --verify-remote: ${lines.length} difference(s)`);
    process.exit(1);
  }
  console.log(`sync-mirrors --verify-remote: OK (${[flag("--no-mirrors") ? "" : "mirrors", flag("--no-npm") ? "" : "npm tarballs"].filter(Boolean).join(" and ")} match)`);
}
