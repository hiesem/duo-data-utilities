import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  // Examples import the package by name; in tests that resolves to the source, as tsconfig "paths" does for tsc.
  resolve: { alias: { "duo-data-utilities": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  define: { __DUO_SDK_VERSION__: JSON.stringify(version) },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
