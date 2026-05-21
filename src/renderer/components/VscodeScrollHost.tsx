import { VscodeScrollable } from '@vscode-elements/react-elements';
import { type ReactNode, type Ref } from 'react';
import { useScrollHostHeight } from '../hooks/useScrollHostHeight';

interface VscodeScrollHostProps {
  className?: string;
  scrollableClassName?: string;
  scrollRef?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * 用 ResizeObserver 为 VscodeScrollable 提供固定像素高度，保留 VS Code 悬浮滚动条样式。
 */
export default function VscodeScrollHost({
  className = '',
  scrollableClassName = '',
  scrollRef,
  children,
}: VscodeScrollHostProps) {
  const { hostRef, height } = useScrollHostHeight();

  return (
    <div
      ref={hostRef}
      className={`sidebar-scroll-host${className ? ` ${className}` : ''}`}
    >
      <VscodeScrollable
        ref={scrollRef}
        className={`sidebar-panel-scroll${scrollableClassName ? ` ${scrollableClassName}` : ''}`}
        style={height > 0 ? { height: `${height}px` } : undefined}
      >
        {children}
      </VscodeScrollable>
    </div>
  );
}
