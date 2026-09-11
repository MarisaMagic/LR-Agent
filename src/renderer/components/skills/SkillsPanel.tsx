import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VscodeIcon,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import type { AgentSkillInventoryItem } from '../../../shared/agentTypes';
import {
  clearSkillsCatalogCache,
  loadSkillsInventory,
  openSkillsRoot,
  revealSkill,
} from '../../services/agentSkills';
import SkillsMenuPortal from './SkillsMenuPortal';
import './SkillsPanel.css';

function statusKind(item: AgentSkillInventoryItem): 'ok' | 'off' | 'error' {
  if (item.status === 'available') return 'ok';
  if (item.status === 'disabled') return 'off';
  return 'error';
}

function statusLabel(item: AgentSkillInventoryItem): string {
  if (item.status === 'available') {
    const extra = item.files.filter((file) => file !== 'SKILL.md').length;
    return extra > 0 ? `${item.files.length} 个文件` : 'SKILL.md';
  }
  return item.reason || (item.status === 'disabled' ? '已禁用' : '未注入');
}

export default function SkillsPanel() {
  const [items, setItems] = useState<AgentSkillInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [menuDir, setMenuDir] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      if (force) clearSkillsCatalogCache();
      const next = await loadSkillsInventory(force);
      setItems(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const available = useMemo(
    () => items.filter((item) => item.status === 'available'),
    [items],
  );
  const skipped = useMemo(
    () => items.filter((item) => item.status !== 'available'),
    [items],
  );

  const toggleExpanded = (dirName: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });
  };

  const closeMenu = () => setMenuOpen(false);
  const finalizeMenuClose = () => {
    setMenuOpen(false);
    setMenuDir(null);
    menuAnchorRef.current = null;
  };

  const toggleMenu = (dirName: string, anchor: HTMLButtonElement) => {
    if (menuDir === dirName && menuOpen) {
      closeMenu();
      return;
    }
    setMenuDir(dirName);
    menuAnchorRef.current = anchor;
    setMenuOpen(true);
  };

  const menuItem = menuDir
    ? (items.find((item) => item.dirName === menuDir) ?? null)
    : null;

  const renderSkillRow = (item: AgentSkillInventoryItem) => {
    const expanded = expandedIds.has(item.dirName);
    const kind = statusKind(item);
    const canExpand = item.files.length > 0;

    return (
      <li key={item.dirName} className="skills-item">
        <div className="skills-row">
          <span className="skills-icon" aria-hidden>
            <VscodeIcon name="lightbulb" size={16} />
          </span>
          <div className="skills-main">
            <div className="skills-head">
              <span className="skills-name">{item.name}</span>
              <span className="skills-source-badge">用户</span>
              {item.name !== item.dirName ? (
                <span className="skills-dir-badge">{item.dirName}</span>
              ) : null}
            </div>
            {item.description ? (
              <p className="skills-desc">{item.description}</p>
            ) : null}
            <button
              type="button"
              className="skills-status"
              onClick={() => toggleExpanded(item.dirName)}
              disabled={!canExpand}
            >
              <span
                className={`skills-status-dot skills-status-dot--${kind}`}
              />
              <span>{statusLabel(item)}</span>
              {canExpand ? (
                <VscodeIcon
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={12}
                />
              ) : null}
            </button>
          </div>
          <button
            type="button"
            className="skills-menu-trigger"
            aria-label="更多操作"
            onClick={(event) => toggleMenu(item.dirName, event.currentTarget)}
          >
            <VscodeIcon name="ellipsis" size={16} />
          </button>
        </div>
        {expanded && item.files.length > 0 ? (
          <ul className="skills-file-list">
            {item.files.map((file) => (
              <li key={file} className="skills-file-row">
                <VscodeIcon
                  name={file === 'SKILL.md' ? 'notebook' : 'file'}
                  size={12}
                />
                <span className="skills-file-name">{file}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="skills-panel">
      <VscodeToolbarContainer className="skills-panel-toolbar">
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refresh(true)}
        />
        <VscodeClickableToolbarButton
          icon="folder-opened"
          label="打开 Skills 目录"
          onClick={() => openSkillsRoot()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="skills-panel-scroll-host"
        scrollableClassName="skills-panel-scrollable"
      >
        <section className="skills-section">
          <h4 className="skills-section-title">
            可用 Skills {loading ? '…' : available.length}
          </h4>
          {loading ? (
            <div className="skills-empty">正在扫描本地 Skills…</div>
          ) : available.length === 0 ? (
            <div className="skills-empty">
              尚未发现可用 Skill。在用户目录{' '}
              <code className="skills-code">
                ~/.agents/skills/&lt;name&gt;/SKILL.md
              </code>{' '}
              放入带 name / description 的 frontmatter 后刷新。
            </div>
          ) : (
            <ul className="skills-list">{available.map(renderSkillRow)}</ul>
          )}
        </section>

        {!loading && skipped.length > 0 ? (
          <section className="skills-section">
            <h4 className="skills-section-title">未注入 {skipped.length}</h4>
            <ul className="skills-list">{skipped.map(renderSkillRow)}</ul>
          </section>
        ) : null}
      </VscodeScrollHost>

      {menuOpen && menuItem && menuAnchorRef.current ? (
        <SkillsMenuPortal
          open
          anchorEl={menuAnchorRef.current}
          onClose={closeMenu}
          onExitComplete={finalizeMenuClose}
          onReveal={() => {
            closeMenu();
            void revealSkill(menuItem.dirName);
          }}
        />
      ) : null}
    </div>
  );
}
