import { URL } from 'url';
import path from 'path';

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

/** True when the URL stays inside this app (dev server origin or packed file://). */
export function isAppOwnedNavigation(url: string): boolean {
  try {
    const target = new URL(url);
    if (process.env.NODE_ENV === 'development') {
      const app = new URL(resolveHtmlPath('index.html'));
      return target.origin === app.origin;
    }
    return target.protocol === 'file:';
  } catch {
    return false;
  }
}
