import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defaultClientConditions, defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import manifest from "./src/manifest.json" with { type: "json" };
import en from "./src/locales/en.json" with { type: "json" };
import zh from "./src/locales/zh.json" with { type: "json" };

const manifests = [
  ["manifest.webmanifest", "en", en.pwa.description],
  ["manifest.zh.webmanifest", "zh-CN", zh.pwa.description],
] as const;

async function notificationWorker(mode: string): Promise<string> {
  const result = await build({
    root: fileURLToPath(new URL(".", import.meta.url)),
    configFile: false,
    publicDir: false,
    mode,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    build: {
      write: false,
      minify: true,
      lib: {
        entry: fileURLToPath(new URL("./src/sw.ts", import.meta.url)),
        name: "MateNotifications",
        formats: ["iife"],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .find((output) => output.type === "chunk");
  if (chunk?.type !== "chunk") throw new Error("Notification worker build produced no script");
  return chunk.code;
}

// Pages live at /app/... and /login, so every asset is addressed from the site root, never relative to the page.
export default defineConfig(({ mode }) => ({
  base: "/",
  // Workspace packages' client entries are built from source, like the tests and the native app do.
  resolve: { conditions: ["mate-source", ...defaultClientConditions] },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "localized-browser-assets",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/sw.js") {
            void notificationWorker(server.config.mode).then((code) => {
              response.setHeader("Content-Type", "application/javascript");
              response.end(code);
            }, next);
            return;
          }
          const localized = manifests.find(([fileName]) => request.url === `/${fileName}`);
          if (localized === undefined) return next();
          const [, lang, description] = localized;
          response.setHeader("Content-Type", "application/manifest+json");
          response.end(JSON.stringify({ ...manifest, lang, description }));
        });
      },
      async generateBundle() {
        this.emitFile({ type: "asset", fileName: "sw.js", source: await notificationWorker(mode) });
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
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": process.env.MATE_CONTROL_PLANE_ORIGIN ?? "http://127.0.0.1:8787" },
  },
}));
