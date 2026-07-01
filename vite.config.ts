import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/client", import.meta.url));
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const SERVER_PORT = process.env.SERVER_PORT ?? "3001";
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? "5173");

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  server: {
    port: CLIENT_PORT,
    // Permite importar tipos de src/shared (fora da raiz do client).
    fs: { allow: [projectRoot] },
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
});
