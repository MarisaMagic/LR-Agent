# 实验脚本

bbox 实验的数据准备、快照、评测与汇总。完整协议见
[`docs/experiments/bbox-eval-protocol.md`](../../docs/experiments/bbox-eval-protocol.md)。

## 一次性准备

```bash
npm run exp:prepare
```

下载 COCO val2017 标注（约 240MB，缓存于 `experiments/data/.cache/`）与所选 10 张图片，
生成 `experiments/data/{source,gt,tasks}`。抽样为轻量化组合：**1–5 框为主（7 张）、
6–15 框为辅（3 张），不含 16–30 框**；三个任务目录使用**同一套 10 张图**
（`manifest.json` 的 `assignments`，design=same）。
然后在应用中分别创建三个任务（图片 / 矩形框），指向 `experiments/data/tasks/{A,B,C}`，
并加入同一套中文标签（人、自行车、汽车、摩托车、公交车、卡车、猫、狗、鸟、马、羊、牛）。

`--count <n>` 可调样本量（默认 10）；`--design split` 可切回「A/B/C 各分一部分图片」
的拆分设计；`--annotations <instances_val2017.json>` 可复用本地标注文件；
`--no-images` 仅生成 GT 与清单（离线自测）。

### 网络问题（下载失败）

脚本按「官方域名 → S3 直链」回退，支持断点续传（`.part`）。若日志出现
`fetch failed` / `TLS` / `SEC_E_WRONG_PRINCIPAL` 等证书类错误，属预期回退路径；
解压产生的中间目录（含 train 大文件，约 800MB）在注解复制成功后会自动清理，
`.cache` 中的 zip（约 240MB）保留以便重跑。全部源都失败时按提示手动处理：

- 手动下载 `annotations_trainval2017.zip` 解压，把 `instances_val2017.json` 放到
  `experiments/data/source/annotations_val2017.json`，重新执行；
- 或直接 `npm run exp:prepare -- --annotations <instances_val2017.json>`；
- 指定单个下载源：`--annotations-url <url>`。

## 运行实验（轻量化同图配对，A → B → C）

准备数据后，三个任务里都是**同一套 10 张图**：每个条件把 10 张全部标一遍（配对设计），
不需要查清单。每次运行单独启动应用并设置对应标签：

```powershell
$env:LR_AGENT_EXPERIMENT_LOG="experiments/runs/events.jsonl"
$env:LR_AGENT_EXPERIMENT_RUN="A"   # 依次改为 A / B / C
npm run dev
```

1. **A（纯手工）**：打开任务 A → 手画框 + 选标签标完全部 10 张 → 打快照：
   ```bash
   npm run exp:snapshot -- --task experiments/data/tasks/A --run A --stage final \
     --meta yolo=yolov8s.pt --meta llm=deepseek-chat
   ```
2. **B（仅预训练）**：任务 B → 每张点「预标注」+ 人工修正，标完全部 10 张 → 打 `--run B --stage final`。
3. **C（全流程）**：
   - 打开任务 C，在 Agent 对话要求「对全部图片执行自动标注」（`all_files=true`）
     → 审查提案 **Keep All 落盘**；
   - 打 AI 阶段快照（尚未人工修正）：
     ```bash
     npm run exp:snapshot -- --task experiments/data/tasks/C --run C --stage ai
     ```
   - 逐图审核修正完全部 10 张 → 打 `--run C --stage final`。

然后每个任务在应用内导出 COCO（`instances.json`），或直接用快照转换：

```bash
npm run exp:to-coco -- --snapshot experiments/runs/A/final --out experiments/results/A/instances.json
# B / C 同理；默认输出到 experiments/results/<run>/instances.json
```

> `exp:to-coco` 从快照读标签与归一化坐标生成 COCO，无需 UI 操作；
> 图片按文件名排序、评测时按文件名对齐，避免导出顺序与 GT 编号不一致的问题。

> 中途重建任务目录（例如改了分配）：`npm run exp:prepare -- --relayout`
> （复用已下载图片，保留任务下的 `.lr-agent`）。

## 评测与汇总

```bash
# 三条件图片相同，统一用全量 GT
npm run exp:eval -- --gt experiments/data/gt/instances_project.json \
  --pred experiments/results/A/instances.json --out experiments/results/metrics/A-final.json

npm run exp:diff -- --ai experiments/runs/C/ai --final experiments/runs/C/final \
  --gt experiments/data/gt/instances_project.json \
  --out experiments/results/metrics/C-corrections.json

npm run exp:summarize
```

- `exp:eval` 需要 `pip install pycocotools`。
- `exp:eval` / `exp:diff` 的 `--out` 目录不存在时会自动创建。
- B 条件的工具栏预标注不产生标签（`labelId=null`），也不单独快照 AI 阶段：
  其质量与成本以最终标注对 GT 的指标和单图耗时为准（协议 §5.2）。
- `exp:summarize` 输出 `experiments/results/summary.md`（人读）与 `summary.json`
  （逐图耗时、token、指标，供统计检验；同图配对，用 Wilcoxon 符号秩检验）。
  `--exclude A` 可排除无效条件（例如被污染的基线），对应指标文件也会被过滤。
- 计时口径（协议 §5.2）：以**会话墙钟 / 平均单图墙钟 / 人工时段（扣除并发 AI 批次）**为主，
  `summary.json` 里含 `sessionSpanMs`、`aiBatchWallMs`、`concurrencyFactor`、`humanAvgPerImageMs` 等字段；
  「单图 open→save 中位」与 `reviewMsByImage` 仅作辅助（后者在重复打开图片时噪声较大）。
