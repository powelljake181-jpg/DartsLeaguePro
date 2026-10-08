import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components is deliberately off for now: the admin area is per-user and
  // live. Revisit for the public pages (see docs/ARCHITECTURE.md).
  // PGlite loads its WASM/data files from its own package directory at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
