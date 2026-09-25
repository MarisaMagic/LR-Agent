import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render } from '@testing-library/react';
import AnnotationLabelOverflowMenuPortal from './AnnotationLabelOverflowMenuPortal';

function makeLabels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `label-${index}`,
    name: `label_${index}`,
    color: '#F44336',
  }));
}

function setup(count: number) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onSelect = jest.fn();
  const onClose = jest.fn();

  render(
    <AnnotationLabelOverflowMenuPortal
      anchorEl={anchor}
      labels={makeLabels(count)}
      activeLabelId={null}
      onSelect={onSelect}
      onClose={onClose}
      chipClassName="chip"
      chipActiveClassName="chip-active"
      chipMenuClassName="chip-menu"
    />,
  );

  const menu = document.body.querySelector(
    '.annotation-label-overflow-menu-portal',
  ) as HTMLElement;
  return { anchor, onSelect, onClose, menu };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('AnnotationLabelOverflowMenuPortal', () => {
  it('使用悬浮滚动区渲染全部标签', () => {
    const { menu } = setup(40);
    expect(menu).toBeTruthy();
    expect(menu.querySelector('.overlay-vertical-scroll-area')).toBeTruthy();
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(40);
  });

  it('菜单内部滚动不关闭菜单（回归：原 bug 一滚就关）', () => {
    const { menu, onClose } = setup(40);

    fireEvent.scroll(
      menu.querySelector('.overlay-vertical-scroll-area') as HTMLElement,
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.scroll(menu.querySelector('[role="option"]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('外部容器滚动仍会关闭菜单', () => {
    const { onClose } = setup(40);
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    fireEvent.scroll(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
