// scripts/sync-mirrors.mjs --commit and --verify-remote (R64-SEC-01, R64-SEC-03, R64-PA-04). Local only: the
// mirrors are committed in temp repos, the "remote" is a local bare repo and the tarballs are built in a temp
// dir. The secret scan is the main repo's scripts/check-secrets.sh with a SYNTHETIC env file (BUILD_INPUTS_ENV),
// an empty listing dir and an empty config home, so no real secret is read; without the main repo (the public
// CI of this repo) the scan cases are skipped.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SDK = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(SDK, "scripts", "sync-mirrors.mjs");
const SCANNER = join(SDK, "..", "scripts", "check-secrets.sh");
const PACKAGES = ["x402-seo-keyword-data", "x402-crypto-derivatives-data", "x402-social-media-data"];
const NOREPLY = "hiesem <4965927+hiesem@users.noreply.github.com>";
const version = (name: string): string => JSON.parse(readFileSync(join(SDK, "packages", name, "package.json"), "utf8")).version;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sync-mirrors-test-"));
  mkdirSync(join(tmp, "listing"));
  mkdirSync(join(tmp, "config"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Env for the script: synthetic scanner inputs; git sees no global or system config. */
function env(secretValue: string): NodeJS.ProcessEnv {
  const file = join(tmp, "synthetic.env");
  writeFileSync(file, `LOG_SALT=${secretValue}\nPAY_TO=0xCD673f7e1daD254347AEab6be0DEFe8b9C6b3A39\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return {
    ...clean,
    BUILD_INPUTS_ENV: file,
    CHECK_SECRETS_LISTING_DIR: join(tmp, "listing"),
    XDG_CONFIG_HOME: join(tmp, "config"),
    HOME: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const node = (args: string[], e: NodeJS.ProcessEnv) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: e, cwd: tmp });
const git = (dir: string, args: string[], e: NodeJS.ProcessEnv) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: e });

function initMirrors(out: string, e: NodeJS.ProcessEnv): void {
  for (const name of PACKAGES) {
    mkdirSync(join(out, name), { recursive: true });
    expect(git(join(out, name), ["init", "-q", "-b", "main"], e).status).toBe(0);
  }
}

describe.skipIf(!existsSync(SCANNER))("sync-mirrors --commit", () => {
  it("a planted secret in a generated tree stops the run before any git call: nothing is staged or committed", () => {
    // The synthetic "secret" is a line every generated src/lib file carries, so each tree contains it.
    const e = env("Generated from https://github.com/hiesem/duo-data-utilities (src/)");
    const out = join(tmp, "mirrors");
    initMirrors(out, e);
    const r = node(["--commit", "--out", out, "--allow-dirty"], e);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("SECRET LEAK: LOG_SALT");
    expect(r.stderr).toContain("nothing was committed");
    expect(r.stdout + r.stderr).not.toContain("Generated from https://github.com/hiesem/duo-data-utilities (src/)");
    for (const name of PACKAGES) {
      expect(git(join(out, name), ["rev-parse", "--verify", "-q", "HEAD"], e).status, name).not.toBe(0);
      expect(existsSync(join(out, name, ".git", "index")), `${name} index`).toBe(false);
    }
  });

  it("commits each clean mirror as the noreply identity, naming version and source SHA; a rerun commits nothing", () => {
    const e = env("synthetic-log-salt-not-in-any-tree-0123456789");
    const out = join(tmp, "mirrors");
    initMirrors(out, e);
    const r = node(["--commit", "--out", out, "--allow-dirty"], e);
    expect(r.status, r.stderr).toBe(0);
    const sha = spawnSync("git", ["-C", SDK, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    for (const name of PACKAGES) {
      const log = git(join(out, name), ["log", "--format=%an <%ae>|%cn <%ce>|%s"], e).stdout.trim().split("\n");
      expect(log, name).toHaveLength(1);
      const [author, committer, subject] = log[0]!.split("|");
      expect(author).toBe(NOREPLY);
      expect(committer).toBe(NOREPLY);
      expect(subject).toContain(`Mirror of ${name} ${version(name)} from hiesem/duo-data-utilities ${sha}`);
      expect(git(join(out, name), ["status", "--porcelain"], e).stdout).toBe("");
    }
    const again = node(["--commit", "--out", out, "--allow-dirty"], e);
    expect(again.status, again.stderr).toBe(0);
    for (const name of PACKAGES) expect(again.stdout).toContain(`${name}: up to date, nothing to commit`);
  });

  it("refuses a mirror directory that is not a git repository", () => {
    const r = node(["--commit", "--out", join(tmp, "plain")], env("synthetic-log-salt-0123456789"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not a git repository");
  });
});

describe("sync-mirrors --commit without a scanner", () => {
  it("refuses to commit unscanned trees", () => {
    const r = node(["--commit", "--out", join(tmp, "m")], { ...env("x"), CHECK_SECRETS: join(tmp, "missing.sh") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("secret scanner not found");
  });
});

describe("sync-mirrors --verify-remote", () => {
  it("passes against remotes holding a fresh generation and names each differing path", () => {
    const e = { ...env("x"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const work = join(tmp, "work");
    expect(node(["--out", work], e).status).toBe(0);
    const remotes = join(tmp, "remotes");
    for (const name of PACKAGES) {
      const dir = join(work, name);
      git(dir, ["init", "-q", "-b", "main"], e);
      git(dir, ["add", "-A"], e);
      expect(git(dir, ["commit", "-q", "-m", "m"], e).status).toBe(0);
      expect(spawnSync("git", ["clone", "-q", "--bare", dir, join(remotes, `${name}.git`)], { env: e }).status).toBe(0);
    }
    const ok = node(["--verify-remote", "--no-npm", "--remote-base", remotes], e);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("sync-mirrors --verify-remote: OK (mirrors match)");

    const stale = join(work, "x402-crypto-derivatives-data");
    writeFileSync(join(stale, "src", "lib", "derivs.ts"), "// stale\n");
    writeFileSync(join(stale, "extra.txt"), "x\n");
    git(stale, ["add", "-A"], e);
    git(stale, ["commit", "-q", "-m", "stale"], e);
    git(stale, ["push", "-q", join(remotes, "x402-crypto-derivatives-data.git"), "main"], e);
    const bad = node(["--verify-remote", "--no-npm", "--remote-base", remotes], e);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("x402-crypto-derivatives-data (mirror): src/lib/derivs.ts differs");
    expect(bad.stdout).toContain("x402-crypto-derivatives-data (mirror): extra.txt only in the remote");
    expect(bad.stdout).not.toContain("x402-seo-keyword-data (mirror)");
  });

  it("diffs package.json and dist/ of the registry and local tarballs of all four packages", () => {
    const names = ["duo-data-utilities", ...PACKAGES];
    const versionOf = (n: string) => (n === "duo-data-utilities" ? JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")).version : version(n));
    const make = (dir: string, edit?: (name: string, root: string) => void) => {
      for (const name of names) {
        const root = join(tmp, "build", dir, name, "package");
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: versionOf(name) }));
        writeFileSync(join(root, "dist", "index.js"), `export const name = ${JSON.stringify(name)};\n`);
        writeFileSync(join(root, "README.md"), "not compared\n");
        edit?.(name, root);
        mkdirSync(join(tmp, dir), { recursive: true });
        spawnSync("tar", ["-czf", join(tmp, dir, `${name}-${versionOf(name)}.tgz`), "-C", join(tmp, "build", dir, name), "package"]);
      }
    };
    make("registry", (_n, root) => writeFileSync(join(root, "README.md"), "different README, not compared\n"));
    make("local");
    const args = ["--verify-remote", "--no-mirrors", "--npm-from", join(tmp, "registry"), "--local-from", join(tmp, "local")];
    const ok = node(args, env("x"));
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("OK (npm tarballs match)");

    make("local", (name, root) => {
      if (name === "x402-social-media-data") writeFileSync(join(root, "dist", "index.js"), "export const stale = true;\n");
      if (name === "duo-data-utilities") writeFileSync(join(root, "dist", "index.cjs"), "module.exports = {};\n");
    });
    const bad = node(args, env("x"));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain(`x402-social-media-data@${version("x402-social-media-data")} (npm): dist/index.js differs`);
    expect(bad.stdout).toContain(`(npm): dist/index.cjs only in the local pack`);
    expect(bad.stdout).not.toContain("README");
  });

  it("rejects unknown options and combined modes", () => {
    expect(node(["--verify-remote", "--commit"], env("x")).status).toBe(2);
    expect(node(["--nope"], env("x")).status).toBe(2);
  });
});
