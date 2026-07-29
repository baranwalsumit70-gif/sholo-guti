import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// If you deploy to GitHub Pages at https://<user>.github.io/<repo>/,
// set base to "/<repo>/". For a custom domain or root deploy, leave it "/".
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES_BASE || "/",
});
