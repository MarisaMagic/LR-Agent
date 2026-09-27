# LR-Agent bbox 智能标注实验协议（v1.6）

> 本文件是实验的**单一真源**：条件定义、数据划分、指标口径、埋点事件契约与运行步骤。
> 协议冻结后，任何影响结果的改动（模型、温度、图片集、流程）必须新开版本号，
> 不得就地修改本文件中的既有定义。

## 1. 目的与主张

LR-Agent 的定位是「AI Agent + 预训练模型推理的智能标注平台」。本实验验证：

| 编号 | 主张 | 对应指标 |
|---|---|---|
| H1 | Agent 预标注 + 人工修正比纯手工显著更快 | 单图端到端耗时、加速比 |
| H2 | 预标注质量足够高，人工修正成本可控 | mAP@0.5、标签正确率、修正率、采纳率 |
| H3 | 「预训练几何 + LLM 语义映射」优于仅预训练输出 | B vs C 的标签正确率 / 采纳率 / 修正数 |

北极星三数：**单图中位耗时下降 X% ｜ 预标注采纳率 ≥ Y% ｜ mAP@0.5 达 Z**。

## 2. 实验条件

| 条件 | 名称 | 流程（人工在环，测总人力） |
|---|---|---|
| A | 纯手工 | 无 AI。手画框 + 从标签池选标签，直到自认为「可直接用于训练」 |
| B | 仅预训练 | 每张图点一次工具栏「预标注」（YOLO 几何，**无标签**），人工删 FP、调框、逐个选标签 |
| C | LR-Agent 全流程 | 在 Agent 对话发一次 `auto_annotate`（YOLO 几何 + LLM 视觉映射），审核提案（Keep All）后逐图修正 |

B 与 C 的差异即「LLM 语义映射 + Agent 编排」的增益；A 与 B/C 的差异即「预标注」的整体价值。

## 3. 数据

- 来源：COCO val2017 验证集（公开 GT）。
- 选取规则（由 `scripts/experiments/prepareCocoSubset.mjs` 执行，固定随机种子）：
  - GT 框全部落在标签池内、无 `iscrowd` 标注；
  - **轻量化抽样**：以 `1–5` 框为主（70%）、`6–15` 框为辅（30%），**不含 16–30 框**，共 **10 张**（7 + 3）；
  - 下载仅所选图片（官方 `images.cocodataset.org` URL，失败自动回退 S3）。
- 标签池（12 类，中文名用于实验）：

  | COCO | 项目标签 | COCO | 项目标签 |
  |---|---|---|---|
  | person | 人 | cat | 猫 |
  | bicycle | 自行车 | dog | 狗 |
  | car | 汽车 | bird | 鸟 |
  | motorcycle | 摩托车 | horse | 马 |
  | bus | 公交车 | sheep | 羊 |
  | truck | 卡车 | cow | 牛 |

- 划分：**同图配对**。三个任务使用**同一套 10 张图**，每张图在 A/B/C 各标注一次
  （配对 → 可用 Wilcoxon 符号秩检验）；`manifest.json` 的 `assignments` 三个条件相同。
  任务目录里就是这 10 张图，打开任务标完即可，无需查清单。
- 评测用全量 `gt/instances_project.json`（三条件图片相同，无需 per-condition GT）。
- 三个任务目录：`experiments/data/tasks/{A,B,C}`，任务名 `LR-Agent-Eval-{A|B|C}`，
  类型「图片 / 矩形框」，标签池同上（同一份中文标签）。

## 4. 运行协议（轻量化、同图配对）

开始前冻结并记录（写入快照元数据，见 §7）：

- App 版本/commit、YOLO 模型 id 与权重、LLM provider / 模型名、`temperature=0`（冻结，不得变动）；
- 机器、显示器、鼠标、无其他重负载任务。

按 A → B → C 顺序各跑一次（每次单独启动应用并设置对应 run 标签），
每次把该任务里的 **10 张图全部标完**（三任务图片相同）：

1. **A（纯手工）**：打开任务 A，逐图手画框 + 选标签，完成全部 10 张后打 `final` 快照。
2. **B（仅预训练）**：打开任务 B，逐图点工具栏「预标注」（YOLO 几何、无标签），
   人工删 FP、调框、逐个选标签；完成后打 `final` 快照。
3. **C（全流程）**：打开任务 C，在 Agent 对话发一次 `auto_annotate`（`all_files=true`）
   → 审查提案 Keep All → 打 **`ai`** 快照 → 逐图修正 → 打 `final` 快照。

每张图的操作约束：

1. 打开图片即开始计时；完成后保存并切到下一张，才允许休息；休息不算入图内时间。
2. 质量口径：产出「可直接用于训练」的标注（不追求完美，也不故意放松）。
3. 开始前先做 5 张热身（任选不参与实验的图，不计入统计）。
4. C 条件允许在批量生成期间休息/做其它事：AI 生成时间由埋点自动记录，
   人工计时以「逐图审核+修正」为准；生成的等待不重复计入单图人工时间。

## 5. 指标定义

### 5.1 质量（对 GT，自动计算）

| 指标 | 口径 | 适用阶段 |
|---|---|---|
| mAP@0.5:0.95 / AP50 / AP75 | COCOeval bbox（pycocotools），按统一类别名对齐；仅对**最终导出**计算（快照无置信度，无法算 mAP） | A/B/C 修正后 |
| Precision / Recall / F1@IoU0.5 | 类别无关匹配（每图贪心，按 score/顺序），IoU≥0.5 计 TP | 全部 |
| 标签正确率 | 框匹配（IoU≥0.5）后类别一致的 TP / 匹配数 | C 的 AI 阶段（仅 C 有 AI 标签）与修正后 |
| 幻觉率 | FP 数 / 预测框总数 | C 的 AI 阶段 |
| 修正后残余错误 | 人工修正后对 GT 的 FP+FN / GT 总数 | 全部 |

- 修正后质量：对三条件的最终 COCO 导出跑 `exp:eval`，三条件都对照同一份 `gt/instances_project.json`。
- C 的 AI 阶段质量：`exp:diff` 输出中的 `gt_ai_stage`（P/R/F1 + 标签正确率）；幻觉率 = 1 − precision。
- B 的 AI 阶段预标注无标签（`labelId=null`）、也不单独快照，其质量以修正后指标为准。

### 5.2 人力（对拍摄的 run）

**主口径①：墙钟。** AI 批量生成是并发的（C 的 10 张 `ai_generate` 同一时刻落日志），
单图 AI 时间不可相加，必须用墙钟：

| 指标 | 口径 |
|---|---|
| 会话墙钟 | 该 run 首事件 → 末事件（条件总耗时，含 AI 等待） |
| 平均单图墙钟 | 会话墙钟 / 打开图片数（主报告值） |
| AI 批次墙钟 | C：`max(ai_generate 结束) − min(ai_generate 开始)`（并发实际墙钟） |
| 并发因子 | 单图 AI 耗时之和 / AI 批次墙钟（体现并发收益） |

**主口径②：人工时段。** `会话墙钟 − AI 批次墙钟`（B 无 AI 批次，等于会话墙钟）；
再除以图片数得「人工时段/图」。

**辅助口径**（仅供对照，不作为结论依据）：

| 指标 | 口径 |
|---|---|
| 单图修正中位 | `image_save(last) − image_open`，对 B 可靠；C 因「无编辑审阅不计时」与重复打开会失真 |
| 审阅停留（reviewMsByImage） | 按 `image_open` 序列：停留 = 下一次 open（或会话末）− 本次 open，按图汇总；重复打开与批处理重叠时噪声大 |
| 修正操作数 | C：AI 阶段快照 → 修正后快照的 diff：保留 / 移动 / 改标签 / 删除 / 新增（含未标注框）。B 为单遍流程，不单独快照 AI 阶段 |
| 采纳率 | C：保留框数 / AI 阶段框数 |
| 主观负荷 | 可选：每条件结束记录 1–10 单题负荷分 |

加速比：默认用「平均单图墙钟」之比，另报「人工时段/图」之比。

### 5.3 系统（自动埋点）

| 指标 | 口径 |
|---|---|
| AI 生成耗时分解 | `ai_generate.timing`：detect / map / finalize / total、round_count |
| token / 张、￥ / 张 | `llm_usage` 事件按 run 聚合 |
| 成功率 / 失败分布 | `ai_generate.ok` 与 `reason` 分类 |
| 边界用例 | 空图/密集图的表现单独列表（可选边界集 10 张，不参与主统计） |

## 6. 埋点事件契约（JSONL）

由主进程写入 `LR_AGENT_EXPERIMENT_LOG` 指向的文件（目录则写 `events.jsonl`），
每行一条，公共字段 `ts`（ISO 时间）、`run`（`LR_AGENT_EXPERIMENT_RUN`，本次为 `A` / `B` / `C`）。

| type | 产生方 | 关键字段 |
|---|---|---|
| `image_open` | 渲染层（标注工作区加载完成） | `projectId`, `relativePath`, `annotationCount` |
| `image_save` | 渲染层（防抖保存成功） | `projectId`, `relativePath`, `annotationCount` |
| `ai_generate` | 渲染层（几何批量子图完成） | `relativePath`, `ok`, `reason`, `rawCount`, `keptCount`, `mappedCount`, `unmappedCount`, `method`, `elapsedMs`, `timing` |
| `preannot_run` | 渲染层（B 条件工具栏预标注） | `relativePath`, `mode`, `boxCount` |
| `llm_usage` | 主进程（LLM 调用结束） | `source`, `model`, `promptTokens`, `completionTokens`, `totalTokens` |

## 7. 目录结构与命令

```
experiments/                      # 运行产物，不入库
  data/                           # exp:prepare 生成
    source/images/                # 10 张原图
    gt/instances_project.json     # 全量 GT（项目标签空间，COCO 格式，三条件共用）
    gt/label_map.json             # COCO ↔ 项目标签映射
    manifest.json                 # 抽样结果 + design + assignments（同图配对）
    tasks/{A,B,C}/images/         # 三个任务目录（同一套 10 张图）
  runs/<A|B|C>/                   # exp:snapshot 生成
    meta.json                     # 模型/版本/时间等冻结信息
    ai/  final/                   # 阶段快照（project.json + annotations/）
  results/<condition>/            # UI 导出的 COCO instances.json
```

命令：

```bash
npm run exp:prepare                 # 下载并生成数据与三个任务目录（需网络，一次性）
npm run exp:prepare -- --relayout   # 仅重建任务目录（复用已下载数据与 manifest.design）
npm run exp:snapshot -- --task experiments/data/tasks/C --run C --stage ai
npm run exp:snapshot -- --task experiments/data/tasks/C --run C --stage final
npm run exp:to-coco -- --snapshot experiments/runs/A/final --out experiments/results/A/instances.json
npm run exp:eval -- --gt experiments/data/gt/instances_project.json \
  --pred experiments/results/A/instances.json --out experiments/results/metrics/A-final.json
npm run exp:eval -- --gt experiments/data/gt/instances_project.json \
  --pred experiments/results/C/instances.json --out experiments/results/metrics/C-final.json
npm run exp:diff -- --ai experiments/runs/C/ai --final experiments/runs/C/final \
  --gt experiments/data/gt/instances_project.json \
  --out experiments/results/metrics/C-corrections.json
npm run exp:summarize               # 汇总 events.jsonl + metrics → 表格
```

> 旧拆分设计的 `gt/instances_{A,B,C}.json` 在同图设计下自动清理，评测统一用
> `instances_project.json`；`exp:diff` 的 `--manifest/--session/--condition` 过滤也不再需要。

启动 App 时开启埋点（开发模式，run 标签按条件改为 A / B / C）：

```bash
# PowerShell
$env:LR_AGENT_EXPERIMENT_LOG="experiments/runs/events.jsonl"; $env:LR_AGENT_EXPERIMENT_RUN="C"; npm run dev
```

### 下载源说明

`exp:prepare` 下载 COCO 注解与图片时优先官方域名
（`images.cocodataset.org`），失败会自动回退到同对象的 S3 直链
（`s3.amazonaws.com/images.cocodataset.org/...`），并支持断点续传（`.part`）。
若全部失败，可手动下载 `annotations_trainval2017.zip` 解压，把
`instances_val2017.json` 放到 `experiments/data/source/annotations_val2017.json`，
或用 `--annotations <文件>` 指定路径离线运行。

## 8. 统计方法（同图配对）

- 主分析：对配对样本用 Wilcoxon 符号秩检验（同一张图的 A vs C、B vs C 耗时与修正数），
  报告中位数 [IQR] 与效应量；样本不足以显著时如实报告置信区间。
- 质量指标：AP/F1 点估计 + 按图 bootstrap 的 95% CI。
- 声明模板：「自标注者预实验（pilot, single annotator），10 张图 × 3 条件同图配对；
  样本量小、条件顺序固定，练习/记忆效应未控制」。

## 9. 局限性（必须写入报告）

1. 单一标注者（作者本人），无法外推标注员群体；
2. COCO 域、12 类、10 张的**小样本**（配对检验可缓解部分图片难度方差，但样本量仍小）；
3. YOLO/LLM 供应商与版本有限，未做跨模型泛化；
4. C 条件的审阅时间包含对 AI 结果的信任/怀疑成本，主观性无法完全消除；
5. **顺序与记忆效应未控制**：条件固定按 A→B→C 执行，且同一批图重复标注三次，
   后一条件可能受熟练度/记忆影响（已按用户要求接受该取舍）。

## 10. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-27 | 初始协议：三条件、40 张 COCO 子集、拉丁方、埋点契约 |
| v1.1 | 2026-09-27 | 口径修正：mAP 仅对最终导出；C 的 AI 阶段质量改用快照 diff（P/R/F1+标签正确率+幻觉率）；`exp:diff` 增加 session 过滤；补下载源回退说明 |
| v1.2 | 2026-09-27 | 简化为一次性设计：分层均衡拆分（每张图标一次）、任务内只含本条件图片、各条件独立 GT、非配对统计；放弃轮转/配对与顺序控制 |
| v1.3 | 2026-09-27 | 样本量扩到 60 张（A/B/C 各 20 张），`--count` 默认 60；`source/images` 自动清理旧抽样遗留图片 |
| v1.4 | 2026-09-27 | 样本量改为 30 张（A/B/C 各 10 张），`--count` 默认 30；任务目录自动清理已移除图片的空标注文档（带标注的孤儿保留并告警） |
| v1.5 | 2026-09-27 | 改为轻量化同图配对：10 张（1–5 框 70% + 6–15 框 30%，无 16–30），三任务同图各标一遍；评测统一用全量 GT；恢复配对统计（Wilcoxon） |
| v1.6 | 2026-09-27 | 计时口径改为双口径：主报告「会话墙钟 / 平均单图墙钟 / 人工时段（扣除并发 AI 批次）」；单图 open→save 中位降为辅助；新增 AI 批次墙钟与并发因子定义 |
