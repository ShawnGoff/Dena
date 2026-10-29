import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, run `dena serve --port 4600` and open the Vite URL with the same #t= token.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:4600", headers: { host: "127.0.0.1:4600" } } } },
  build: { outDir: "dist", emptyOutDir: true },
});
