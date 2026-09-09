"""系统提示与帮助文案：标注入口不泄漏存储路径。"""

from app.agent.context_snapshot import (
    build_assist_system_prompt,
    format_snapshot_for_prompt,
)
from app.agent.tools.help import get_lr_agent_help
from app.schemas.agent import AnnotationProjectSnapshotInput, ClientContextInput


def _bbox_snapshot() -> AnnotationProjectSnapshotInput:
    return AnnotationProjectSnapshotInput(
        project_id="p1",
        name="faces",
        modality="image",
        annotation_type="bbox",
        labels=[{"id": "face", "name": "人脸"}],
    )


def _build_prompt(client_context: ClientContextInput) -> str:
    return build_assist_system_prompt(
        client_context,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )


def test_snapshot_prompt_does_not_leak_annotation_storage_path() -> None:
    snap = format_snapshot_for_prompt(_bbox_snapshot())
    assert ".lr-agent/annotations" not in snap
    assert "list_workspace_directory" in snap


def test_project_system_prompt_routes_annotation_writes_to_tools() -> None:
    prompt = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            agent_mode="annotation",
            annotation_project_snapshot=_bbox_snapshot(),
        )
    )
    assert ".lr-agent/annotations" not in prompt
    assert "auto_annotate" in prompt
    assert "mutate_annotation" in prompt
    assert "不要用写文件工具保存标注" in prompt
    assert "查已有标注 JSON" not in prompt


def test_proposal_ledger_appended_to_system_prompt() -> None:
    ctx = ClientContextInput(
        workspace_root="/ws",
        proposal_ledger="【未确认提案】未 Keep All，未写盘。\n- annotation pending data/8.jpg append",
    )
    prompt = build_assist_system_prompt(
        ctx,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )
    assert "【未确认提案】" in prompt
    assert "data/8.jpg" in prompt


def test_help_annotation_topic_does_not_leak_storage_path() -> None:
    text = get_lr_agent_help("标注")
    assert ".lr-agent/annotations" not in text
    assert "auto_annotate" in text
    assert "mutate_annotation" in text
