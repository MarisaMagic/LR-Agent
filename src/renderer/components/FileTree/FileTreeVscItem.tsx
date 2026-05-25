import {
  VscodeProgressRing,
  VscodeTreeItem,
} from '@vscode-elements/react-elements';
import FileTypeIcon from '../FileTypeIcon';
import { FileNode } from '../../types/file';

interface FileTreeVscItemProps {
  node: FileNode;
  expandedPaths: Set<string>;
  activeFilePath: string | null;
}

export default function FileTreeVscItem({
  node,
  expandedPaths,
  activeFilePath,
}: FileTreeVscItemProps) {
  const isFolder = node.type === 'folder';
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = activeFilePath === node.path;

  return (
    <VscodeTreeItem
      slot="children"
      branch={isFolder}
      open={isExpanded}
      selected={isSelected}
    >
      {isFolder ? (
        <>
          <FileTypeIcon
            slot="icon-branch"
            path={node.path}
            isFolder
            isOpen={false}
          />
          <FileTypeIcon
            slot="icon-branch-opened"
            path={node.path}
            isFolder
            isOpen
          />
        </>
      ) : (
        <FileTypeIcon slot="icon-leaf" path={node.path} />
      )}
      <span
        className={isFolder ? 'file-tree-item-label' : undefined}
        data-file-path={node.path}
      >
        {node.name}
      </span>
      {node.isLoading ? <VscodeProgressRing slot="decoration" /> : null}
      {isFolder && node.children
        ? node.children.map((child) => (
            <FileTreeVscItem
              key={child.path}
              node={child}
              expandedPaths={expandedPaths}
              activeFilePath={activeFilePath}
            />
          ))
        : null}
    </VscodeTreeItem>
  );
}
