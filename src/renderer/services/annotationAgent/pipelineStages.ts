export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  prepare: '准备批量标注',
  task: '解析任务',
  catalog: '扫描图片',
  scope: '解析范围',
  plan: '生成计划',
  workers: '批量处理',
  worker: '处理图片',
  tool: '工具调用',
};

export function labelForPipelineStage(stage: string): string {
  return PIPELINE_STAGE_LABELS[stage] ?? stage;
}
