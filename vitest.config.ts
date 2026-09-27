import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));
const packages = readdirSync(packagesDir);

const alias: Record<string, string> = {
  "@agent-farmework/core/testing": `${packagesDir}/core/src/testing.ts`,
};
for (const pkg of packages) alias[`@agent-farmework/${pkg}`] = `${packagesDir}/${pkg}/src/index.ts`;

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      resolve: { alias },
      test: { name, include: [`packages/${name}/src/**/*.test.ts`], environment: "node" },
    })),
    passWithNoTests: true,
  },
});
