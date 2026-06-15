import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "node",
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["source/**/*.ts"],
            exclude: ["source/index.ts"],
            thresholds: { lines: 70 },
        },
    },
});
