// Check if the renderer and main bundles are built
import path from 'path';
import chalk from 'chalk';
import fs from 'fs';
import { TextEncoder, TextDecoder } from 'node:util';
import webpackPaths from '../configs/webpack.paths';

const mainPath = path.join(webpackPaths.distMainPath, 'main.js');
const rendererPath = path.join(webpackPaths.distRendererPath, 'renderer.js');
const agentRuntimePath = path.join(
  webpackPaths.distMainPath,
  'agentRuntime.js',
);

if (!fs.existsSync(mainPath)) {
  throw new Error(
    chalk.whiteBright.bgRed.bold(
      'The main process is not built yet. Build it by running "npm run build:main"',
    ),
  );
}

// Agent 运行时是独立的 webpack 入口（见 .erb/configs/webpack.config.main.*.ts
// 的 agentRuntime），由主进程 utilityProcess.fork 启动。缺失时只在运行期才失败，
// 构建期完全无感，故在这里一并断言。
if (!fs.existsSync(agentRuntimePath)) {
  throw new Error(
    chalk.whiteBright.bgRed.bold(
      'The Agent runtime bundle is not built yet. Build it by running "npm run build:main"',
    ),
  );
}

if (!fs.existsSync(rendererPath)) {
  throw new Error(
    chalk.whiteBright.bgRed.bold(
      'The renderer process is not built yet. Build it by running "npm run build:renderer"',
    ),
  );
}

// JSDOM does not implement TextEncoder and TextDecoder
if (!global.TextEncoder) {
  // @ts-expect-error Node util TextEncoder typing vs global DOM lib
  global.TextEncoder = TextEncoder;
}
if (!global.TextDecoder) {
  // @ts-ignore
  global.TextDecoder = TextDecoder;
}
