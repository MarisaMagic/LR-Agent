/**
 * MCP 广场预设目录。
 *
 * 注意：第三方端点会随厂商调整，仅 Tavily / Context7 预填稳定 URL；
 * 智谱、通义等仅提供文档链接与协议模板，由用户粘贴实际端点。
 */
import { MCP_API_KEY_PLACEHOLDER, type McpPreset } from './mcpTypes';

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'tavily',
    name: 'Tavily 网页搜索',
    description:
      '实时网页搜索与内容抽取（tavily-search / tavily-extract 等）。在 tavily.com 获取 API Key。',
    url: 'https://mcp.tavily.com/mcp',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://github.com/tavily-ai/tavily-mcp',
    icon: 'tavily',
  },
  {
    id: 'context7',
    name: 'Context7 文档查询',
    description:
      '查询主流库的最新官方文档与代码示例（resolve-library-id / query-docs）。API Key 可选。',
    url: 'https://mcp.context7.com/mcp',
    transport: 'streamable_http',
    requiresApiKey: false,
    apiKeyHeader: 'CONTEXT7_API_KEY',
    apiKeyTemplate: MCP_API_KEY_PLACEHOLDER,
    docsUrl: 'https://context7.com',
    icon: 'context7',
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      '仓库、Issue、PR 与代码搜索。使用 GitHub PAT（repo 等权限）作为 API Key。',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://github.com/github/github-mcp-server',
    icon: 'github',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description:
      '模型、数据集与 Spaces 检索。在 huggingface.co/settings/tokens 创建 Token。',
    url: 'https://huggingface.co/mcp',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://huggingface.co/settings/mcp',
    icon: 'huggingface',
  },
  {
    id: 'zhipu-web-search',
    name: '智谱网页搜索',
    description:
      '智谱开放平台 web_search MCP（SSE 协议）。端点形如 https://open.bigmodel.cn/api/mcp/web_search/sse，请在控制台复制带鉴权的完整地址。',
    url: '',
    transport: 'sse',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://docs.bigmodel.cn',
    icon: 'zhipu-web-search',
  },
  {
    id: 'qwen-vl',
    name: '通义识图（百炼）',
    description:
      '阿里云百炼 MCP 广场的通义视觉理解服务。请在百炼控制台开通后复制 MCP 端点 URL。',
    url: '',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://bailian.console.aliyun.com',
    icon: 'qwen-vl',
  },
];

export function getMcpPreset(id: string): McpPreset | null {
  return MCP_PRESETS.find((preset) => preset.id === id) ?? null;
}
