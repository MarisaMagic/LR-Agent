import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import { ToastProvider } from '../../context/ToastContext';
import type { LabelDefinition } from '../../types/annotation';
import LabelEditor from './LabelEditor';

function makeLabels(count: number): LabelDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `label-${index}`,
    name: `label_${index}`,
    color: '#F44336',
  }));
}

describe('LabelEditor 滚动', () => {
  it('长标签列表使用悬浮滚动区（回归：不再用原生滚动条）', () => {
    const { container } = render(
      <ToastProvider>
        <LabelEditor labels={makeLabels(200)} onChange={() => {}} />
      </ToastProvider>,
    );

    expect(
      container.querySelector('.overlay-vertical-scroll-area'),
    ).toBeTruthy();
    expect(container.querySelector('.label-editor-list')).toBeTruthy();
    expect(container.querySelectorAll('.label-editor-row')).toHaveLength(200);
  });

  it('空标签时展示提示文案', () => {
    const { container, getByText } = render(
      <ToastProvider>
        <LabelEditor labels={[]} onChange={() => {}} emptyHint="暂无标签" />
      </ToastProvider>,
    );

    expect(getByText('暂无标签')).toBeTruthy();
    expect(container.querySelector('.overlay-vertical-scroll-area')).toBeNull();
  });
});
