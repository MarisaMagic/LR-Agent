"""Assist 模式系统提示词组装：运行时身份、任务指令与客户端上下文快照。"""
from __future__ import annotations

from app.schemas.agent import AnnotationProjectSnapshotInput, ClientContextInput, SkillCatalogEntryInput

# 精简后的 prompt 常量 —— 规则由代码层承担，不靠模型理解
VISION_HINT = """- 看图描述：按需调用 read_image_for_vision。
- 查已有标注：read_file_annotation。"""

_ANNOTATION_SCOPE_HINT = (
    "【标注工具】paths 填 list_workspace_directory 的 relativePath；全部文件才设 all_files=true。"
)
_ANNOTATION_KNOWN_TYPES: frozenset[str] = frozenset(
    {
        "bbox",
        "caption",
        "classification",
        "polygon",
        "keypoint",
        "rotated_bbox",
        "span_ner",
        "text_classification",
        "instruction",
        "preference",
        "conversation",
        "cot",
    }
)
_ANNOTATION_TYPE_EXTRAS: dict[str, str] = {
    "polygon": "需配置检测模型与 SAM2 分割模型。",
    "keypoint": "需先选择骨架模板并配置关键点模型。",
    "rotated_bbox": "需配置 OBB 检测模型。",
}

# 不需要展示检测模型列表的标注类型
_DETECTION_MODEL_TYPES: frozenset[str] = frozenset({"bbox", "polygon", "keypoint", "rotated_bbox"})

WORKSPACE_ASSIST_TASK = """【任务】在 LR-Agent 内回答用户问题，按需使用工具完成读/写/分析操作。
{vision_hint}
- 用自然、简洁的中文回复。
- 调用工具前先用一两句中文说明下一步要做什么。"""

ASSISTANT_TASK_BASE = """【任务】在 LR-Agent 内完成问答、标注、分析、写文件。
- 新增/重写标注用 auto_annotate；改已有标注用 mutate_annotation。不要用写文件工具保存标注。
- 写文件工具只用于工作区文档与代码。
{vision_hint}
- 用简洁中文回复；调用工具前用一两句说明下一步。"""

# 向后兼容保留旧常量引用（如有外部引用）
WRITE_TOOL_GUIDE = ""
TOOL_DISCIPLINE = ""
VISION_RULES = ""
EXECUTION_TOOL_GUIDE = ""
PLANNING_GUIDE = ""
FILE_WRITE_INTEGRITY = ""


def format_runtime_identity_block(
    *,
    model: str,
    provider_label: str = "",
    supports_vision: bool = False,
) -> str:
    label = provider_label.strip() or "（未命名提供商）"
    if supports_vision:
        vision_line = "视觉能力：已通过 API 探针，可调用 read_image_for_vision 并在调用后查看附图。"
    else:
        vision_line = (
            "视觉能力：未通过探针或未检测。不要声称能分析图片像素；"
            "若用户要看图，说明需在「大模型配置」中选用支持视觉的模型并重新检测视觉。"
        )
    return (
        "【你的身份】\n"
        f"- 你是后端模型 `{model}`（配置名称：{label}）。\n"
        f"- {vision_line}\n"
        "- 你在 LR-Agent 系统内与用户对话、调用工具完成任务；不要把自己说成独立的「LR-Agent 助手」或其它品牌模型。"
    )


def format_snapshot_for_prompt(snapshot: AnnotationProjectSnapshotInput) -> str:
    labels = snapshot.labels or []
    label_lines = [
        f"- {item.get('id', '')}: {item.get('name', '')}"
        for item in labels[:40]
        if isinstance(item, dict)
    ]
    annotation_type = snapshot.annotation_type or ""
    lines = [
        f"项目 ID: {snapshot.project_id}",
        f"项目名称: {snapshot.name}",
        f"模态: {snapshot.modality}",
        f"标注类型: {annotation_type}",
        "标签列表:",
        *(label_lines or ["- （无）"]),
    ]

    # 仅在目标检测类标注类型时展示可用的检测模型
    if annotation_type in _DETECTION_MODEL_TYPES:
        models = snapshot.detection_models or []
        model_lines = [
            f"- {m.get('id', '')}: {m.get('name', '')}"
            + (" (默认)" if m.get("is_default") else "")
            for m in models[:12]
            if isinstance(m, dict)
        ]
        lines.append("可用检测模型（object_detection）:")
        lines.extend(model_lines or ["- （未配置或未传入）"])

    if annotation_type in _ANNOTATION_KNOWN_TYPES:
        extra = _ANNOTATION_TYPE_EXTRAS.get(annotation_type)
        lines.append(
            f"{_ANNOTATION_SCOPE_HINT} {extra}" if extra else _ANNOTATION_SCOPE_HINT
        )

    return "\n".join(lines)


def build_workspace_assistant_system_prompt(client_context: ClientContextInput | None) -> str:
    task = WORKSPACE_ASSIST_TASK.format(vision_hint=VISION_HINT)
    if client_context is None:
        return task
    parts = [task]
    if client_context.workspace_root:
        parts.append(f"\n【工作区】\n根目录: {client_context.workspace_root}")
    if client_context.active_file_path:
        parts.append(f"当前打开文件: {client_context.active_file_path}")
    return "\n".join(parts)


def build_project_assistant_system_prompt(client_context: ClientContextInput | None) -> str:
    task = ASSISTANT_TASK_BASE.format(vision_hint=VISION_HINT)
    if client_context is None or client_context.annotation_project_snapshot is None:
        return task
    snap = client_context.annotation_project_snapshot
    return (
        f"{task}\n\n"
        f"【当前标注项目快照】\n{format_snapshot_for_prompt(snap)}"
    )


def format_skills_catalog_block(
    skills: list[SkillCatalogEntryInput] | None,
) -> str:
    """把全局 skills catalog（name + description）格式化为 prompt 块；空时不输出。"""
    if not skills:
        return ""
    lines = [
        "【可用 Skills】",
        "以下为可用的任务工作流 Skills。当用户请求与某 skill 的 description 匹配时，"
        "先调用 read_agent_skill(skill_name) 读取该 SKILL.md 正文，再按其中步骤执行；"
        "不要凭名字猜测内容。",
    ]
    for item in skills:
        name = (item.name or "").strip()
        desc = (item.description or "").strip()
        if not name or not desc:
            continue
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines)


def build_assist_system_prompt(
    client_context: ClientContextInput | None,
    *,
    model: str,
    provider_label: str = "",
    supports_vision: bool = False,
) -> str:
    identity = format_runtime_identity_block(
        model=model,
        provider_label=provider_label,
        supports_vision=supports_vision,
    )
    if client_context and client_context.work_mode == "editor":
        task = build_workspace_assistant_system_prompt(client_context)
    elif client_context and client_context.annotation_project_snapshot is not None:
        task = build_project_assistant_system_prompt(client_context)
    elif client_context and (client_context.workspace_root or "").strip():
        task = build_workspace_assistant_system_prompt(client_context)
    else:
        task = WORKSPACE_ASSIST_TASK
    editor_note = ""
    if client_context and client_context.work_mode == "editor":
        editor_note = (
            "\n【编辑器模式】当前为编辑器模式：禁止调用标注读写、批量标注、标注变更与标注数据分析相关工具；"
            "可使用 read_workspace_file、write_workspace_file、read_document_file 等通用工具。"
        )
    base = f"{identity}\n\n{task}"
    if editor_note:
        base = f"{base}{editor_note}"
    instructions = (client_context.project_instructions or "").strip() if client_context else ""
    if instructions:
        base = f"{base}\n\n【项目指令】\n{instructions}"
    memory_enabled = bool(
        client_context and client_context.workspace_memory_enabled
    )
    if memory_enabled:
        memory_index = (
            (client_context.memory_index or "").strip() if client_context else ""
        )
        index_block = (
            memory_index
            if memory_index
            else "（尚无工作区记忆文件。进度与已标文件将在用户确认或保存标注后由系统生成。）"
        )
        base = (
            f"{base}\n\n【工作区记忆】\n{index_block}\n"
            "这是本标注任务的工作区记忆，可有多个 Markdown 文件。"
            "progress.md 与 annotated-files.md 由系统在用户确认或标注落盘后更新；"
            "需要细节时用 memory_read，不要凭印象改计数。"
            "memory_create / memory_write 只用于用户规范、标注偏好与纠正"
            "（如 conventions.md、preferences.md）；不要把未确认提案写成已完成。"
            "项目指令优先级高于记忆。"
        )
    skills = (client_context.skills_catalog or []) if client_context else []
    skills_block = format_skills_catalog_block(skills)
    if skills_block:
        base = f"{base}\n\n{skills_block}"
    ledger = (client_context.proposal_ledger or "").strip() if client_context else ""
    if ledger:
        base = f"{base}\n\n{ledger}"
    return base
