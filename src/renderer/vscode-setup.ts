import './styles/vscode-theme.css';
import './styles/overlay-scroll.css';
import codiconStylesheetHref from '@vscode/codicons/dist/codicon.css';
import '@vscode/codicons/dist/codicon.ttf';

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
