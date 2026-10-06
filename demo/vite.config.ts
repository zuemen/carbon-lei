import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSES_FILE = "assets/third-party-licenses.txt";

/**
 * Writes the licence texts of the libraries bundled into the Communication Template worker to
 * dist/assets/third-party-licenses.txt (and serves the same text in dev). The panel links to it.
 */
function thirdPartyLicenses(): Plugin {
  const require = createRequire(fileURLToPath(new URL("../sdk/package.json", import.meta.url)));
  // Walk up from the package's entry point (fflate's "exports" does not expose package.json).
  const pkgDir = (name: string) => {
    for (let d = dirname(require.resolve(name)); d !== dirname(d); d = dirname(d)) {
      const pj = join(d, "package.json");
      if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return d;
    }
    throw new Error(`package directory of ${name} not found`);
  };
  const sections: [string, string, string][] = [
    ["exceljs", "MIT", "LICENSE"],
    ["jszip", "MIT or GPLv3 (dual-licensed; used here under MIT); bundled inside exceljs", "LICENSE.markdown"],
    ["fflate", "MIT", "LICENSE"],
  ];
  const text = () =>
    [
      "Third-party licences of the libraries in the CarbonLEI demo's Communication Template reader",
      "(the worker that parses .xlsx files). Other dependencies are listed in the README.",
      "",
      ...sections.flatMap(([name, licence, file]) => {
        const dir = pkgDir(name);
        const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
        return ["=".repeat(78), `${name} ${version} (${licence})`, "=".repeat(78), readFileSync(join(dir, file), "utf8").trim(), ""];
      }),
    ].join("\n");
  return {
    name: "carbonlei-third-party-licenses",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split("?")[0].endsWith(`/${LICENSES_FILE}`)) return next();
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: LICENSES_FILE, source: text() });
    },
  };
}

// Served from https://zuemen.github.io/carbon-lei/ (GitHub Pages project site).
export default defineConfig({
  base: process.env.DEMO_BASE ?? "/carbon-lei/",
  plugins: [react(), thirdPartyLicenses()],
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  // The template worker's dependencies are pre-bundled at startup, so the dev server does not reload the page
  // when the worker first imports them.
  optimizeDeps: { include: ["exceljs", "fflate"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
