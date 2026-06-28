import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { installMonacoEnvironment } from './monacoEnvironment';

installMonacoEnvironment();

monaco.editor.defineTheme('lr-agent-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1e1e',
  },
});

monaco.editor.defineTheme('lr-agent-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
  },
});
