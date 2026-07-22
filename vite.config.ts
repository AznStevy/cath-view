import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so GitHub Pages / any subpath host works
  base: "./",
  server: {
    port: 5173,
  },
});
