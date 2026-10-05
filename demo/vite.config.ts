import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Served from https://zuemen.github.io/carbon-lei/ (GitHub Pages project site).
export default defineConfig({
  base: process.env.DEMO_BASE ?? "/carbon-lei/",
  plugins: [react()],
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
