import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { name, version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { name: string; version: string };

export default defineConfig({
  define: { __DUO_SDK_VERSION__: JSON.stringify(version), __DUO_SDK_NAME__: JSON.stringify(name) },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
