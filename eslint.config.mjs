import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'main.js',
      '.pcw/**',
      'packages/*/dist/**',
      'packages/*/node_modules/**',
    ],
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
    files: ['**/*.{js,cjs}'],
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
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
  },
  {
    files: [
      'packages/standalone/src/standalone-client.js',
      'packages/standalone/src/standalone-mcp-settings.js',
      'packages/vscode/src/vscode-webview-client.js',
      'packages/vscode/src/vscode-mcp-settings.js',
    ],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
  },
];
