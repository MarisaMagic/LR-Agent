import { useMemo, useRef, useState } from 'react';
import { VscodeIcon, VscodeLabel } from '@vscode-elements/react-elements';
import {
  AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import { getLabelChipStyle } from '../../utils/labelColor';
import AnnotationProjectMenuPortal from './AnnotationProjectMenuPortal';
import './AnnotationProjectList.css';

interface AnnotationProjectListProps {
  projects: AnnotationProject[];
  activeProjectId: string | null;
  loading: boolean;
  onOpen: (projectId: string) => void;
  onDelete: (project: AnnotationProject) => void;
  onEdit: (project: AnnotationProject) => void;
  onShowInFolder: (project: AnnotationProject) => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '从未打开';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '从未打开';
  return date.toLocaleString();
}

export default function AnnotationProjectList({
  projects,
  activeProjectId,
  loading,
  onOpen,
  onDelete,
  onEdit,
  onShowInFolder,
}: AnnotationProjectListProps) {
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const sorted = useMemo(
    () =>
      [...projects].sort((a, b) => {
        const aTime = a.lastOpenedAt ?? a.updatedAt;
        const bTime = b.lastOpenedAt ?? b.updatedAt;
        return bTime.localeCompare(aTime);
      }),
    [projects],
  );

  const menuProject = menuProjectId
    ? (sorted.find((project) => project.id === menuProjectId) ?? null)
    : null;

  const closeMenu = () => {
    setMenuProjectId(null);
    menuAnchorRef.current = null;
  };

  const openMenu = (projectId: string, anchor: HTMLButtonElement) => {
    setMenuProjectId(projectId);
    menuAnchorRef.current = anchor;
  };

  const toggleMenu = (projectId: string, anchor: HTMLButtonElement) => {
    if (menuProjectId === projectId) {
      closeMenu();
      return;
    }
    openMenu(projectId, anchor);
  };

  if (loading) {
    return (
      <div className="annotation-project-list-empty">
        <VscodeLabel>加载标注任务…</VscodeLabel>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="annotation-project-list-empty">
        <VscodeIcon name="tag" size={32} />
        <VscodeLabel>暂无标注任务</VscodeLabel>
        <p>点击上方「新建标注任务」开始创建</p>
      </div>
    );
  }

  return (
    <>
      <ul className="annotation-project-list">
        {sorted.map((project) => {
          const isActive = project.id === activeProjectId;
          const menuOpen = menuProjectId === project.id;

          return (
            <li
              key={project.id}
              className={`annotation-project-card${
                isActive ? ' annotation-project-card-active' : ''
              }${menuOpen ? ' annotation-project-card-menu-open' : ''}`}
            >
              <div className="annotation-project-card-body">
                <button
                  type="button"
                  className="annotation-project-card-main"
                  onClick={() => onOpen(project.id)}
                >
                  <div className="annotation-project-card-title-row">
                    <VscodeIcon
                      name={
                        project.modality === 'image'
                          ? 'file-media'
                          : 'file-text'
                      }
                      size={16}
                    />
                    <span className="annotation-project-card-title">
                      {project.name}
                    </span>
                  </div>
                  <div className="annotation-project-card-meta">
                    {TASK_TYPE_CONFIG[project.modality].label} ·{' '}
                    {getAnnotationTypeLabel(
                      project.modality,
                      project.annotationType,
                    )}
                  </div>
                  <div
                    className="annotation-project-card-path"
                    title={project.directoryPath}
                  >
                    {project.directoryPath}
                  </div>
                  {project.description && (
                    <div className="annotation-project-card-desc">
                      {project.description}
                    </div>
                  )}
                  <div className="annotation-project-card-labels">
                    {project.labels.length === 0 ? (
                      <span className="annotation-project-card-labels-empty">
                        未定义标签
                      </span>
                    ) : (
                      project.labels.map((label) => (
                        <span
                          key={label.id}
                          className="annotation-project-label-chip"
                          style={getLabelChipStyle(label.color)}
                        >
                          {label.name}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="annotation-project-card-time">
                    最近打开：{formatDate(project.lastOpenedAt)}
                  </div>
                </button>
              </div>

              <div className="annotation-project-card-actions">
                <button
                  type="button"
                  className="annotation-project-menu-trigger"
                  aria-label="更多操作"
                  aria-expanded={menuOpen}
                  ref={(element) => {
                    if (element) {
                      triggerRefs.current.set(project.id, element);
                    } else {
                      triggerRefs.current.delete(project.id);
                    }
                  }}
                  onClick={(event) => {
                    toggleMenu(project.id, event.currentTarget);
                  }}
                >
                  <VscodeIcon name="kebab-vertical" size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {menuProject && menuAnchorRef.current && (
        <AnnotationProjectMenuPortal
          anchorEl={menuAnchorRef.current}
          onClose={closeMenu}
          onOpen={() => {
            closeMenu();
            onOpen(menuProject.id);
          }}
          onEdit={() => {
            closeMenu();
            onEdit(menuProject);
          }}
          onShowInFolder={() => {
            closeMenu();
            onShowInFolder(menuProject);
          }}
          onDelete={() => {
            closeMenu();
            onDelete(menuProject);
          }}
        />
      )}
    </>
  );
}
