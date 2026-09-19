/**
 * 开发期探针：转储工具的 JSON Schema，用于与 Python 侧逐字对照。
 *
 * 用法：npx ts-node scripts/agent-baseline/dumpToolSchema.ts [工具名...]
 *
 * 不传工具名时转储全部。
 */

import { toolsByName, toToolSpec } from '../../src/main/agent/tools/registry';

const wanted = process.argv.slice(2);
const tools = toolsByName();
const names = wanted.length ? wanted : [...tools.keys()];

for (const name of names) {
  const tool = tools.get(name);
  if (!tool) {
    console.log(`=== ${name}: NOT FOUND ===`);
    continue;
  }
  const spec = toToolSpec(tool);
  console.log(`=== ${name} (${tool.kind}) ===`);
  console.log(`description: ${tool.description}`);
  console.log(JSON.stringify(spec.function.parameters, null, 1));
  console.log('');
}
