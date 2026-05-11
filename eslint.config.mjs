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
    files: ["components/creatives/**/*.{js,jsx,ts,tsx}"],
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
