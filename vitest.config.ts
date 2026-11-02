import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/config.ts",
        "src/types.ts",
        "src/db/index.ts",
        "src/parsers/index.ts",
        "src/parsers/rust.ts",
        "src/parsers/typescript.ts",
        "src/parsers/markdown.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 90,
        lines: 80,
      },
    },
  },
});
