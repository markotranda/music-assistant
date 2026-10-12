import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Node-style relative imports use explicit .js extensions (nodenext);
    // map them back to their .ts sources for tests.
    extensionAlias: { ".js": [".ts", ".js"] },
    // Workspace packages resolve to source, never stale dist output.
    alias: {
      "@ma/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@ma/integrations": fileURLToPath(
        new URL("./packages/integrations/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["{packages,apps}/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
