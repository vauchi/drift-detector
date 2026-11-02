// SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
// SPDX-License-Identifier: GPL-3.0-or-later

// ESLint v9 flat config. Replaces the missing `.eslintrc.*` left after
// the eslint:^9.20.1 / @typescript-eslint:^8.24.0 upgrade — `npm run
// lint` has been silently unrunnable in this repo since v9 dropped the
// auto-find for legacy configs.
//
// Minimal preset: the recommended rule sets from @eslint/js +
// @typescript-eslint, scoped to src/ + tests/. dist/, node_modules/,
// and the queries/ tree-sitter blobs are ignored.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "queries/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2024,
      sourceType: "module",
      // Node.js for the bin/CLI side + fetch/URL/Response for the MCP
      // SDK transport that bridges this package over HTTP. The repo
      // doesn't ship a browser bundle, but the `fetch` family of
      // globals lives in modern Node so we pull both packs.
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // typescript-eslint upstream recommendation: `no-undef` is
      // disabled in TS projects because tsc itself enforces it more
      // accurately (and the rule mis-fires on type-only refs like
      // `RequestInit` that have no runtime presence).
      "no-undef": "off",
      // Underscore-prefixed unused params/vars are the project's
      // intentional-discard convention (e.g. test mocks: `(_url,
      // _init) => …`); honour it.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Tests legitimately use any-typed test fixtures + dynamic
      // property access; tone the strictest TS rules down rather
      // than scattering disables across the suite.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
