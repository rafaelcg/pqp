import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/release/**",
      "client/public/**",
      "**/*.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Underscore-prefixed args are the codebase's "intentionally unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  {
    files: ["client/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // The `eslint-disable react-hooks/exhaustive-deps` comments in this
      // codebase referenced a rule that was never installed; it is real now.
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
    },
  },

  {
    files: ["server/src/**/*.ts", "packages/shared/src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Server logging is the intended observability channel here.
      "no-console": "off",
    },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  {
    // Ambient declaration files exist to be merged into, so every name in them
    // reads as unused.
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    // Standalone Node ESM tooling, run with `node scripts/…`.
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      globals: { ...globals.node, WebSocket: "readonly", fetch: "readonly" },
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
    },
  },

  {
    // The Electron main process is CommonJS by design.
    files: ["electron/**/*.js"],
    languageOptions: {
      globals: globals.node,
      sourceType: "commonjs",
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
