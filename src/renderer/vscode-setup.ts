import './styles/vscode-theme.css';
import './styles/app-buttons.css';
import './styles/overlay-scroll.css';
import '@fontsource/noto-sans-sc/chinese-simplified-400.css';
import codiconStylesheetHref from '@vscode/codicons/dist/codicon.css';
import '@vscode/codicons/dist/codicon.ttf';
import { applyHighlightTheme } from './theme/highlightTheme';
import type { EffectiveTheme } from './theme/themeConstants';

function ensureCodiconStylesheet(): void {
  let link = document.getElementById(
    'vscode-codicon-stylesheet',
  ) as HTMLLinkElement | null;

  if (!link) {
    link = document.createElement('link');
    link.id = 'vscode-codicon-stylesheet';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

  if (codiconStylesheetHref && link.href !== codiconStylesheetHref) {
    link.href = codiconStylesheetHref;
  }
}

ensureCodiconStylesheet();

const bootstrapTheme = document.documentElement.dataset.theme;
if (bootstrapTheme === 'dark' || bootstrapTheme === 'light') {
  applyHighlightTheme(bootstrapTheme as EffectiveTheme);
}
