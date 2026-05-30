import {
  VscodeLabel,
  VscodeScrollable,
  VscodeToolbarContainer,
  VscodeTree,
  VscodeTreeItem,
} from '@vscode-elements/react-elements';
import type { VscTreeSelectEvent } from '@vscode-elements/elements/dist/vscode-tree/vscode-tree.js';
import { useCallback, useLayoutEffect, useRef, type ComponentRef } from 'react';
import FileTypeIcon from './FileTypeIcon';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import { useApp } from '../context/AppContext';
import { useAnnotation } from '../context/AnnotationContext';
import { basename } from '../types/file';
import {
  clearAncestorIndentGuides,
  clearTreeSelections,
  getPathFromTreeItem,
  getTreeFromItem,
  handleTreeSelect,
  isTreeItemBranch,
  syncActiveFileSelection,
  syncTreeOpenState,
} from '../utils/tree-select';
import FileTreeVscItem from './FileTree/FileTreeVscItem';
import VscodeScrollHost from './VscodeScrollHost';
import './FileTree.css';

export default function FileTree() {
  const {
    rootPath,
    tree,
    expandedPaths,
    activeFilePath,
    openFolder,
    toggleFolder,
    selectFile,
    refreshTree,
  } = useApp();
  const { clearActiveProject } = useAnnotation();

  const handleOpenFolder = useCallback(() => {
    clearActiveProject();
    openFolder();
  }, [clearActiveProject, openFolder]);

  const scrollableRef = useRef<ComponentRef<typeof VscodeScrollable>>(null);

  useLayoutEffect(() => {
    const treeEl = scrollableRef.current?.querySelector('vscode-tree');
    if (!treeEl) return undefined;

    const sync = () => {
      syncTreeOpenState(treeEl, expandedPaths);
      syncActiveFileSelection(treeEl, activeFilePath);
    };

    sync();
    const frameId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frameId);
  }, [activeFilePath, expandedPaths, tree, rootPath]);

  const onTreeSelect = useCallback(
    (event: VscTreeSelectEvent) => {
      const item = Array.isArray(event.detail)
        ? event.detail[0]
        : event.detail?.selectedItems?.[0];
      const itemTree = item ? getTreeFromItem(item) : null;

      if (item && isTreeItemBranch(item) && itemTree) {
        clearTreeSelections(itemTree);
      }

      const folderPath =
        item && isTreeItemBranch(item) ? getPathFromTreeItem(item) : null;
      const willExpand =
        folderPath !== null ? !expandedPaths.has(folderPath) : false;

      handleTreeSelect(event, toggleFolder, selectFile);

      // 方案 A：展开状态仅由 React expandedPaths 决定，立即写回 WC.open
      if (item && isTreeItemBranch(item) && folderPath) {
        (item as HTMLElement & { open?: boolean }).open = willExpand;
        queueMicrotask(() => clearAncestorIndentGuides(item));
      }
    },
    [toggleFolder, selectFile, expandedPaths],
  );

  return (
    <div className="file-tree">
      <VscodeToolbarContainer className="file-tree-toolbar">
        <VscodeClickableToolbarButton
          icon="folder-opened"
          label="打开文件夹"
          onClick={handleOpenFolder}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshTree()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="file-tree-scroll-host"
        scrollableClassName="file-tree-scrollable"
        scrollRef={scrollableRef}
      >
        {rootPath ? (
          <VscodeTree
            expandMode="doubleClick"
            indentGuides="onHover"
            indent={8}
            onVscTreeSelect={onTreeSelect}
          >
            <VscodeTreeItem
              branch
              open={expandedPaths.has(rootPath)}
              selected={activeFilePath === rootPath}
            >
              <FileTypeIcon
                slot="icon-branch"
                path={rootPath}
                isFolder
                isOpen={false}
              />
              <FileTypeIcon
                slot="icon-branch-opened"
                path={rootPath}
                isFolder
                isOpen
              />
              <span className="file-tree-item-label" data-file-path={rootPath}>
                {basename(rootPath)}
              </span>
              {tree.map((node) => (
                <FileTreeVscItem
                  key={node.path}
                  node={node}
                  expandedPaths={expandedPaths}
                  activeFilePath={activeFilePath}
                />
              ))}
            </VscodeTreeItem>
          </VscodeTree>
        ) : (
          <div className="file-tree-empty">
            <VscodeLabel>点击「打开文件夹」选择工作区</VscodeLabel>
          </div>
        )}
      </VscodeScrollHost>
    </div>
  );
}
