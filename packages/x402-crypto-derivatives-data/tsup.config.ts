import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Bundles the shared client code from ../../src into this package (no dependency on duo-data-utilities).
const { name, version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { name: string; version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  platform: "node",
  target: "node18",
  define: { __DUO_SDK_VERSION__: JSON.stringify(version), __DUO_SDK_NAME__: JSON.stringify(name) },
});
