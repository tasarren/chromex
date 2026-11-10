import { defineConfig } from "vite"

// Fixed names: manifest.json references background.js and popup.html directly.
export default defineConfig({
  base: "./",
  publicDir: "static",
  server: { host: "127.0.0.1", port: 5173, strictPort: true, open: "/popup.html" },
  build: {
    emptyOutDir: true,
    modulePreload: false,
    outDir: "dist",
    rolldownOptions: {
      input: { background: "src/background.ts", popup: "popup.html" },
      output: {
        assetFileNames: "[name][extname]",
        chunkFileNames: "[name].js",
        entryFileNames: "[name].js",
      },
    },
    sourcemap: false,
    target: "chrome116",
  },
})
