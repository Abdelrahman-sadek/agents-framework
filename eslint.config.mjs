import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.tsbuildinfo', '**/coverage/**'],
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json' },
      globals: { ...globals.node, ...globals.es2023 },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, import: importPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      'no-unused-vars': 'off',
      'no-console': 'warn',
      'no-throw-literal': 'error',
      'no-duplicate-imports': 'error',
      'import/no-cycle': 'warn',
    },
    settings: {
      'import/resolver': { typescript: {} },
    },
  },
);
