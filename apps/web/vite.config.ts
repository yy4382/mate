import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pages live at /app/... and /login, so every asset is addressed from the site root, never relative to the page.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": process.env.MATE_CONTROL_PLANE_ORIGIN ?? "http://127.0.0.1:8787" },
  },
});
