import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const archiveImportMessage =
  "Imports from lib/archive/ are forbidden — these are retired V1/V2/V2.1 engines.";

export default [
  {
    ignores: [
      ".next/**",
      ".claude/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/archive/**", "lib/archive/**", "@/lib/archive/**"],
              message: archiveImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    // Hook ordering is a correctness rule, not a style one, and it was scoped
    // to one directory. A hook below an early return means the render that
    // takes the early path uses a different hook count, and React throws
    // "Rendered fewer hooks than expected" -- so a *failed refetch* crashes the
    // page instead of showing the error state. Two surfaces were doing exactly
    // that: Overview below its error return, and the report chart below its
    // empty-data guard.
    //
    // app/api is excluded because it holds no React: the rule there only fires
    // on server helpers whose names happen to begin with "use".
    files: [
      "app/**/*.{js,jsx,ts,tsx}",
      "components/**/*.{js,jsx,ts,tsx}",
      "hooks/**/*.{js,jsx,ts,tsx}",
      "store/**/*.{js,jsx,ts,tsx}",
    ],
    ignores: ["app/api/**"],
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["lib/archive/**/*.{js,jsx,mjs,ts,tsx,mts}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
