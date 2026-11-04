import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: 4318,
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 650 },
});
