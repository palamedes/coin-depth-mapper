/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the built page also works from any static file host (lite mode).
  base: "./",
  build: {
    outDir: "../src/relief_depth_studio/web",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: "es" },
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
