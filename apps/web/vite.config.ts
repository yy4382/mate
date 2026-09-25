import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controlPlaneOrigin = process.env.MATE_CONTROL_PLANE_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": controlPlaneOrigin,
    },
  },
});
