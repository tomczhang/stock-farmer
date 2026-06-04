import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/signal-report": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
    __BUILD_COMMIT__: JSON.stringify(process.env.VITE_BUILD_COMMIT ?? "dev"),
  },
});
