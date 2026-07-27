/**
 * Wrapper for generate-vscode-icons.py (requires Pillow).
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

execFileSync('python', [join(__dirname, 'generate-vscode-icons.py')], {
  stdio: 'inherit',
});
