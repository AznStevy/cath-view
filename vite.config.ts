import { defineConfig } from "vite";

export default defineConfig({
  // Must match the GitHub Pages project path: https://<user>.github.io/cath-view/
  base: "/cath-view/",
  server: {
    port: 5173,
  },
});
