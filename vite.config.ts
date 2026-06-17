import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The viewer engine (src/main.js) imports three via npm; map the CDN-style
// "three/addons/" specifiers to three's bundled examples. The Python render
// backend (server.py) owns /api/*, proxied here in dev. Production builds to
// dist/, which server.py serves.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: "three/examples/jsm/" }],
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
