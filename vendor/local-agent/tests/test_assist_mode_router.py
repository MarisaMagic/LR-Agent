from app.agent.assist_mode_router import (
    ASK_TOOL_SET,
    FULL_TOOL_SET,
    LIGHT_TOOL_SET,
    WRITE_TOOL_NAMES,
    resolve_assist_tool_set,
)


def test_ask_tool_set_strips_writes():
    assert WRITE_TOOL_NAMES.isdisjoint(ASK_TOOL_SET)
    assert "read_file_annotation" in ASK_TOOL_SET
    assert "read_image_for_vision" in ASK_TOOL_SET
    assert "list_workspace_directory" in ASK_TOOL_SET
    assert "glob_workspace" in ASK_TOOL_SET
    assert "str_replace_workspace_file" not in ASK_TOOL_SET
    for name in WRITE_TOOL_NAMES:
        assert name in FULL_TOOL_SET
        assert name not in ASK_TOOL_SET


def test_light_still_has_write_workspace_file():
    assert "write_workspace_file" in LIGHT_TOOL_SET
    assert "str_replace_workspace_file" in LIGHT_TOOL_SET
    assert "delete_workspace_file" in LIGHT_TOOL_SET
    assert "glob_workspace" in LIGHT_TOOL_SET
    assert "auto_annotate" not in LIGHT_TOOL_SET


def test_resolve_assist_tool_set_fail_closed_when_mode_missing():
    tools = resolve_assist_tool_set(
        has_project_snapshot=True,
        agent_mode=None,
        is_editor=False,
        has_workspace=True,
    )
    assert tools == ASK_TOOL_SET
    assert WRITE_TOOL_NAMES.isdisjoint(tools)


def test_resolve_assist_tool_set_full_only_in_annotation_mode():
    tools = resolve_assist_tool_set(
        has_project_snapshot=True,
        agent_mode="annotation",
        is_editor=False,
        has_workspace=True,
    )
    assert tools == FULL_TOOL_SET
    assert WRITE_TOOL_NAMES.issubset(tools)
