import { builtinModules } from "node:module"
import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript"
import importX from "eslint-plugin-import-x"
import { defineConfig } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

const tsFiles = ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"]
const jsFiles = ["**/*.mjs", "**/*.cjs"]
const tsProjects = [
  "packages/extension/tsconfig.json",
  "packages/extension/tsconfig.node.json",
  "packages/mcp/tsconfig.json",
  "packages/plugin/tsconfig.json",
  "packages/protocol/tsconfig.json",
]

// Shipped code must not import build, lint, test or Inspector tools. Patterns are gitignore-style,
// so a root such as "typescript" also matches its subpaths ("typescript/lib/typescript.js").
const devTools = [
  "@eslint/*",
  "@modelcontextprotocol/inspector",
  "@stylistic/*",
  "chrome-types",
  "eslint",
  "eslint-*",
  "jscpd",
  "rolldown",
  "tsdown",
  "vitest",
  "@vitest/*",
  "playwright",
  "typescript",
  "typescript-eslint",
  "vite",
]
const devToolMessage = "Runtime code cannot import build, lint or test tools."
// Browser code (extension and the wire contract it bundles) has no Node runtime.
const nodeModules = builtinModules.flatMap((name) =>
  name.startsWith("node:") ? [name] : [name, `node:${name}`],
)

// Shared Harness rules; workspace-specific restrictions stay below.
const style = {
  "@stylistic/array-bracket-spacing": ["error", "never"],
  "@stylistic/comma-dangle": ["error", "always-multiline"],
  "@stylistic/eol-last": ["error", "always"],
  "@stylistic/indent": ["error", 2],
  "@stylistic/key-spacing": "error",
  "@stylistic/keyword-spacing": "error",
  "@stylistic/no-extra-semi": "error",
  "@stylistic/no-trailing-spaces": "error",
  "@stylistic/object-curly-spacing": ["error", "always"],
  "@stylistic/quotes": ["error", "double"],
  "@stylistic/semi": ["error", "never"],
  "@stylistic/space-before-blocks": "error",
  "@stylistic/space-before-function-paren": ["error", "never"],
  "@stylistic/space-infix-ops": "error",
  "import-x/first": "error",
  "import-x/newline-after-import": "error",
  "import-x/no-duplicates": "error",
  "import-x/no-relative-packages": "error",
  "import-x/no-self-import": "error",
  "import-x/no-useless-path-segments": "error",
  "no-console": "error",
}
const plugins = { "@stylistic": stylistic, "import-x": importX }
const sourceImports = {
  regex: "^\\.\\.?/.*\\.js$",
  message: "Use .ts extensions for relative TypeScript source imports.",
}

function restrict(patterns, message) {
  const group = [...new Set(patterns)]
  return { "no-restricted-imports": ["error", { patterns: [sourceImports, { group, message }] }] }
}

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/.*/**"],
  },
  js.configs.recommended,
  {
    files: jsFiles,
    plugins,
    languageOptions: { globals: globals.node },
    rules: style,
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    plugins,
    languageOptions: {
      parserOptions: { project: tsProjects, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver({ project: tsProjects })],
    },
    rules: {
      ...style,
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/preserve-caught-error": "off",
      "@typescript-eslint/require-await": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          enableAutofixRemoval: { imports: true },
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-imports": ["error", { patterns: [sourceImports] }],
    },
  },
  // The root Vitest config belongs to no package tsconfig.
  { files: ["vitest.config.ts"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["packages/extension/src/**/*.ts", "packages/protocol/src/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: restrict(
      [...devTools, ...nodeModules],
      "Browser runtime code cannot import Node modules or build, lint and test tools.",
    ),
  },
  {
    files: ["packages/mcp/src/**/*.ts", "packages/plugin/src/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: restrict(devTools, devToolMessage),
  },
  {
    files: ["packages/*/test/**/*.ts", "packages/*/*.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // The e2e global setup imports the development fixture server directly; it is not shipped code.
    files: ["packages/mcp/test/e2e/setup.ts"],
    rules: { "import-x/no-relative-packages": "off" },
  },
  {
    // These command-line checks report results on stdout; MCP diagnostics use stderr.
    files: ["scripts/*.mjs"],
    rules: { "no-console": "off" },
  },
)
