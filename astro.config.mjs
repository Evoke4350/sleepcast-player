// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

const SITE_URL = process.env.PUBLIC_SITE_URL ?? "http://localhost:3000";

export default defineConfig({
  site: SITE_URL,
  // Static pages, served by Workers Static Assets; the one server route,
  // /api/relay, is the Worker in worker/ (see wrangler.jsonc).
  output: "static",
  security: {
    // Astro owns the CSP because it alone knows the hashes of the inline
    // scripts it emits to hydrate islands — a hand-written script-src without
    // them blocks hydration outright (the app renders an empty shell). On
    // static pages it is a <meta> tag, where frame-ancestors doesn't work:
    // that one is a header, in public/_headers.
    csp: {
      directives: [
        "default-src 'self'",
        "upgrade-insecure-requests",
        "img-src 'self' https: data: blob:", // podcast artwork is arbitrary https
        "media-src 'self' https: blob:", // episode audio is arbitrary https
        "connect-src 'self' https:", // feed relay
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        // gtag.js, loaded only after the visitor accepts (lib/analytics.ts).
        resources: ["'self'", "https://www.googletagmanager.com"],
      },
    },
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
