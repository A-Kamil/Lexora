import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The Python prototype and generated artifacts are never linted.
    ignores: ['**/dist/**', 'emmanuel/**', 'packages/db/drizzle/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Secrets and message bodies must never reach stdout from library code.
      'no-console': 'error',
    },
  },
  {
    // Operator-facing scripts are allowed to print (redacted) progress.
    files: ['packages/db/src/{migrate,seed}.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
