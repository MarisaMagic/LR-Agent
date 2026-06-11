import type { PipelineKind } from '../../../shared/agentTypes';

export const ANALYSIS_PIPELINE_STAGE_LABELS: Record<string, string> = {
  collect: '收集数据',
  prepare: '生成脚本',
  execute: '运行脚本',
  summarize: '解读结果',
};

export const MUTATION_PIPELINE_STAGE_LABELS: Record<string, string> = {
  prepare: '解析意图',
  resolve: '定位目标',
};

export const REPORT_PIPELINE_STAGE_LABELS: Record<string, string> = {
  collect: '收集数据',
  prepare: '生成报告',
};

export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  prepare: '准备',
  resolve: '定位目标',
  task: '解析任务',
  catalog: '扫描图片',
  scope: '解析范围',
  plan: '生成计划',
  workers: '批量处理',
  worker: '处理图片',
  judge: '评分复核',
  retry: '重新打标签',
  tool: '工具调用',
};

const STAGE_LABELS_BY_KIND: Record<PipelineKind, Record<string, string>> = {
  batch: PIPELINE_STAGE_LABELS,
  analysis: ANALYSIS_PIPELINE_STAGE_LABELS,
  mutation: MUTATION_PIPELINE_STAGE_LABELS,
  report: REPORT_PIPELINE_STAGE_LABELS,
};

export function labelForPipelineStage(
  stage: string,
  pipelineKind: PipelineKind = 'batch',
): string {
  const table = STAGE_LABELS_BY_KIND[pipelineKind] ?? PIPELINE_STAGE_LABELS;
  return table[stage] ?? stage;
}
