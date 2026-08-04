// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig,
    {
        // Flat config declares no environment by default — every Node global (process,
        // console, fetch, URL, Buffer...) was falling through eslint:recommended's
        // no-undef as if this were browser code with nothing defined. Verified this was
        // failing identically under `npm ci` (CI's exact pinned deps), not a local-only
        // quirk — every future PR would have hit this the moment it touched a file using
        // any of these globals.
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "no-console": ["warn", { allow: ["warn", "error"] }],
        },
    },
    {
        ignores: ["dist/**", "node_modules/**"],
    },
);
