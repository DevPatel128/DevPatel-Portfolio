import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', '.wrangler/**', '.claude/**'],
    },
    js.configs.recommended,
    {
        // Edge runtime — the Worker and its tests
        files: ['worker/**/*.js', 'test/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.worker,
            },
        },
        rules: {
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // Browser bundle — classic script, no modules (loaded via <script src>)
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                turnstile: 'readonly',
            },
        },
        rules: {
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
];
