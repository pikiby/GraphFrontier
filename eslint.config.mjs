import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'main.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.node,
        window: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        ResizeObserver: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-console': 'off',
      'no-useless-escape': 'off',
    },
  },
];
