import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src`, import.meta.url));

const alias = {
  "@agent-framework/core/testing": `${src("core")}/testing.ts`,
  "@agent-framework/core": `${src("core")}/index.ts`,
  "@agent-framework/llm": `${src("llm")}/index.ts`,
  "@agent-framework/tools": `${src("tools")}/index.ts`,
};

export default defineConfig({
  test: {
    projects: ["core", "llm", "tools"].map((name) => ({
      resolve: { alias },
      test: { name, include: [`packages/${name}/src/**/*.test.ts`], environment: "node" },
    })),
  },
});
