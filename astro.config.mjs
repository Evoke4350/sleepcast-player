// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

const SITE_URL = process.env.PUBLIC_SITE_URL ?? "http://localhost:3000";

export default defineConfig({
  site: SITE_URL,
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    // Astro owns the CSP because it alone knows the hashes of the inline
    // scripts it emits to hydrate islands — a hand-written script-src without
    // them blocks hydration outright (the app renders an empty shell).
    csp: {
      directives: [
        "default-src 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
        "img-src 'self' https: data: blob:", // podcast artwork is arbitrary https
        "media-src 'self' https: blob:", // episode audio is arbitrary https
        "connect-src 'self' https:", // feed relay + model weights
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        // The in-browser MiniLM (transformers.js) compiles WASM.
        resources: ["'self'", "'wasm-unsafe-eval'"],
      },
    },
  },
  integrations: [react()],
  server: { port: 3000, host: true },
  vite: {
    plugins: [tailwindcss()],
  },
});
