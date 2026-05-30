import type { ReactNode } from 'react';

export const pdfjs = {
  GlobalWorkerOptions: { workerSrc: '' },
  version: '0.0.0',
};

export function Document({ children }: { children?: ReactNode }) {
  return <div data-testid="react-pdf-document">{children}</div>;
}

export function Page() {
  return null;
}
