module.exports = {
  extends: 'erb',
  plugins: ['@typescript-eslint'],
  env: {
    node: true,
    browser: true,
  },
  globals: {
    NodeJS: 'readonly',
  },
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': 'error',
    // TypeScript optional props; defaultProps not used in this codebase
    'react/require-default-props': 'off',
    'react/jsx-props-no-spreading': 'off',
    'no-underscore-dangle': 'off',
    'no-plusplus': 'off',
    'no-void': 'off',
    'no-continue': 'off',
    'no-bitwise': 'off',
    'no-nested-ternary': 'off',
    'promise/always-return': 'off',
    'promise/catch-or-return': 'off',
    'import/prefer-default-export': 'off',
    'no-restricted-syntax': 'off',
    'global-require': 'off',
    'no-new': 'off',
    'react/no-array-index-key': 'off',
    'jsx-a11y/label-has-associated-control': 'off',
    'react-hooks/exhaustive-deps': 'warn',
    'no-console': 'warn',
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
        moduleDirectory: ['node_modules', 'src/'],
      },
      webpack: {
        config: require.resolve('./.erb/configs/webpack.config.eslint.ts'),
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
};
