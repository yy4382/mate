import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import manifest from "./src/manifest.json" with { type: "json" };
import en from "./src/locales/en.json" with { type: "json" };
import zh from "./src/locales/zh.json" with { type: "json" };

const manifests = [
  ["manifest.webmanifest", "en", en.pwa.description],
  ["manifest.zh.webmanifest", "zh-CN", zh.pwa.description],
] as const;

// Pages live at /app/... and /login, so every asset is addressed from the site root, never relative to the page.
export default defineConfig({
  base: "/",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "localized-manifests",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/sw.js") {
            response.setHeader("Content-Type", "application/javascript");
            response.end('import "/src/sw.ts";');
            return;
          }
          const localized = manifests.find(([fileName]) => request.url === `/${fileName}`);
          if (localized === undefined) return next();
          const [, lang, description] = localized;
          response.setHeader("Content-Type", "application/manifest+json");
          response.end(JSON.stringify({ ...manifest, lang, description }));
        });
      },
      generateBundle() {
        for (const [fileName, lang, description] of manifests) {
          this.emitFile({
            type: "asset",
            fileName,
            source: JSON.stringify({ ...manifest, lang, description }),
          });
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": process.env.MATE_CONTROL_PLANE_ORIGIN ?? "http://127.0.0.1:8787" },
  },
});
