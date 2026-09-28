import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.STEWARD_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": process.env.STEWARD_API_ORIGIN ?? "http://localhost:3000" },
  },
  build: { outDir: "dist" },
});
