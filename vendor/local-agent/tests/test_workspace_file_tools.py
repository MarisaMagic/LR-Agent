"""Tests for workspace path resolution and file read tools."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent.tools.workspace_file_reader import (
    VISION_PATH_MARKER,
    extract_vision_path_from_tool_result,
    read_image_for_vision_tool,
    read_workspace_text_file,
)
from app.agent.tools.workspace_path import allowed_roots, resolve_workspace_file
from app.core.config import Settings
from app.schemas.agent import ClientContextInput


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text(
        "def hello():\n    print('hello')\n\nclass Foo:\n    pass\n",
        encoding="utf-8",
    )
    (root / "notes.md").write_text("# Title\n", encoding="utf-8")
    (root / "secret").mkdir()
    (root / "secret" / "outside.txt").write_text("nope", encoding="utf-8")
    return root


@pytest.fixture
def client_context(workspace: Path) -> ClientContextInput:
    return ClientContextInput(
        workspace_root=str(workspace),
        active_file_path=str(workspace / "src" / "main.py"),
        active_relative_path="src/main.py",
    )


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-for-unit-tests")
    monkeypatch.setenv("POSTGRES_PASSWORD", "test")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://lr_agent:test@localhost:5432/lr_agent",
    )
    monkeypatch.setenv("REDIS_PASSWORD", "test")
    monkeypatch.setenv("REDIS_URL", "redis://:test@localhost:6379/0")
    return Settings()


def test_allowed_roots_deduplicates(workspace: Path) -> None:
    ctx = ClientContextInput(
        workspace_root=str(workspace),
        project_directory_path=str(workspace),
    )
    roots = allowed_roots(ctx)
    assert len(roots) == 1


def test_resolve_relative_path(client_context: ClientContextInput) -> None:
    resolved, err = resolve_workspace_file(client_context, "src/main.py")
    assert err == ""
    assert resolved is not None
    assert resolved.name == "main.py"


def test_resolve_active_file_when_path_empty(client_context: ClientContextInput) -> None:
    resolved, err = resolve_workspace_file(client_context, "")
    assert err == ""
    assert resolved is not None
    assert resolved.name == "main.py"


def test_reject_path_traversal(client_context: ClientContextInput) -> None:
    resolved, err = resolve_workspace_file(client_context, "../secret/outside.txt")
    assert resolved is None
    assert ".." in err or "未找到" in err


def test_read_workspace_text(client_context: ClientContextInput, settings: Settings) -> None:
    content = read_workspace_text_file(client_context, "notes.md", settings=settings)
    assert "Title" in content
    assert content.startswith("文件：")
    assert "     1|# Title" in content


def test_read_workspace_line_range(client_context: ClientContextInput, settings: Settings) -> None:
    content = read_workspace_text_file(
        client_context,
        "src/main.py",
        settings=settings,
        start_line=2,
        end_line=3,
    )
    assert "行范围：L2-L3" in content
    assert "print('hello')" in content
    assert "     2|" in content
    assert "class Foo" not in content


def test_read_workspace_invalid_line_range(
    client_context: ClientContextInput,
    settings: Settings,
) -> None:
    content = read_workspace_text_file(
        client_context,
        "src/main.py",
        settings=settings,
        start_line=10,
        end_line=2,
    )
    assert "无效行范围" in content


def _write_numbered_file(path: Path, count: int) -> None:
    path.write_text(
        "".join(f"line-{i}\n" for i in range(1, count + 1)),
        encoding="utf-8",
    )


def test_read_line_range_beyond_max_lines(
    client_context: ClientContextInput,
    workspace: Path,
    settings: Settings,
) -> None:
    """行范围超出 max_lines 预截断时仍能读到（流式窗口）。"""
    _write_numbered_file(workspace / "big.py", 300)
    small = settings.model_copy(update={"agent_read_file_max_lines": 50})
    content = read_workspace_text_file(
        client_context,
        "big.py",
        settings=small,
        start_line=120,
        end_line=125,
    )
    assert "行范围：L120-L125" in content
    assert "line-123" in content
    assert "   120|line-120" in content


def test_read_line_range_beyond_max_bytes(
    client_context: ClientContextInput,
    workspace: Path,
    settings: Settings,
) -> None:
    """行范围超出 max_bytes 预截断时仍能读到。"""
    _write_numbered_file(workspace / "long.py", 300)
    small = settings.model_copy(update={"agent_read_file_max_bytes": 128})
    content = read_workspace_text_file(
        client_context,
        "long.py",
        settings=small,
        start_line=250,
        end_line=255,
    )
    assert "line-253" in content
    assert "   250|line-250" in content


def test_read_line_range_window_capped_by_max_lines(
    client_context: ClientContextInput,
    workspace: Path,
    settings: Settings,
) -> None:
    """窗口超过 max_lines 时截断并提示可继续分段。"""
    _write_numbered_file(workspace / "wide.py", 300)
    small = settings.model_copy(update={"agent_read_file_max_lines": 10})
    content = read_workspace_text_file(
        client_context,
        "wide.py",
        settings=small,
        start_line=5,
        end_line=100,
    )
    assert "行窗口已截断" in content
    assert "    5|line-5" in content
    assert "   14|line-14" in content
    assert "line-15" not in content


def test_read_line_range_start_beyond_eof(
    client_context: ClientContextInput,
    workspace: Path,
    settings: Settings,
) -> None:
    _write_numbered_file(workspace / "short.py", 5)
    content = read_workspace_text_file(
        client_context,
        "short.py",
        settings=settings,
        start_line=100,
    )
    assert "起始行超出文件末尾" in content
    assert "共 5 行" in content


def test_read_truncated_hint_points_to_line_range(
    client_context: ClientContextInput,
    workspace: Path,
    settings: Settings,
) -> None:
    """无行范围且被截断时，提示可用 start_line/end_line 分段读取。"""
    _write_numbered_file(workspace / "huge.py", 300)
    small = settings.model_copy(update={"agent_read_file_max_bytes": 128})
    content = read_workspace_text_file(client_context, "huge.py", settings=small)
    assert "内容已截断" in content
    assert "start_line" in content


def test_read_image_for_vision_returns_marker(
    workspace: Path,
) -> None:
    from PIL import Image

    img_path = workspace / "photo.jpg"
    Image.new("RGB", (8, 8), color=(255, 0, 0)).save(img_path, format="JPEG")
    ctx = ClientContextInput(workspace_root=str(workspace))
    raw = read_image_for_vision_tool(ctx, "photo.jpg", provider_is_vision=True)
    data = json.loads(raw)
    assert data["ok"] is True
    assert VISION_PATH_MARKER in data
    path = extract_vision_path_from_tool_result("read_image_for_vision", raw)
    assert path == str(img_path.resolve())


def test_read_image_requires_vision_model(client_context: ClientContextInput) -> None:
    result = read_image_for_vision_tool(
        client_context,
        "src/main.py",
        provider_is_vision=False,
    )
    assert "视觉" in result


def test_read_document_docx(
    workspace: Path,
    settings: Settings,
) -> None:
    pytest.importorskip("docx")
    from docx import Document

    doc_path = workspace / "readme.docx"
    doc = Document()
    doc.add_paragraph("Hello DOCX")
    doc.save(doc_path)

    from app.agent.tools.workspace_file_reader import read_document_file

    ctx = ClientContextInput(workspace_root=str(workspace))
    text = read_document_file(ctx, "readme.docx", settings=settings)
    assert "Hello DOCX" in text


def test_write_path_rejects_lr_agent_dir(client_context: ClientContextInput) -> None:
    from app.agent.tools.workspace_path import resolve_workspace_write_path

    resolved, err = resolve_workspace_write_path(
        client_context,
        ".lr-agent/annotations/files/abc.json",
    )
    assert resolved is None
    assert "auto_annotate" in err
    assert "mutate_annotation" in err


def test_write_path_allows_normal_file(client_context: ClientContextInput) -> None:
    from app.agent.tools.workspace_path import resolve_workspace_write_path

    resolved, err = resolve_workspace_write_path(client_context, "reports/summary.md")
    assert err == ""
    assert resolved is not None
    assert resolved.name == "summary.md"


def test_str_replace_unique_match(client_context: ClientContextInput) -> None:
    from app.agent.tools.workspace_file_reader import str_replace_workspace_file_tool
    import json

    raw = str_replace_workspace_file_tool(
        client_context,
        "src/main.py",
        "print('hello')",
        "print('hi')",
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert "print('hi')" in data["content"]
    assert data["operation"] == "write"


def test_str_replace_requires_unique_match(client_context: ClientContextInput, workspace) -> None:
    from app.agent.tools.workspace_file_reader import str_replace_workspace_file_tool
    import json

    (workspace / "dup.txt").write_text("foo\nfoo\n", encoding="utf-8")
    raw = str_replace_workspace_file_tool(client_context, "dup.txt", "foo", "bar")
    data = json.loads(raw)
    assert data["ok"] is False
    assert "出现" in data["summary"]


def test_delete_workspace_file_proposal(client_context: ClientContextInput) -> None:
    from app.agent.tools.workspace_file_reader import delete_workspace_file_tool
    import json

    raw = delete_workspace_file_tool(client_context, "notes.md")
    data = json.loads(raw)
    assert data["ok"] is True
    assert data["operation"] == "delete"
    assert data["relative_path"].endswith("notes.md")
