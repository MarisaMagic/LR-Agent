import {
  resolveMutationTargets,
  labelIdByName,
} from './mutationTargetResolver';
import type { BboxAnnotation } from '../../types/annotationDocument';

const labels = [
  { id: 'l1', name: 'person', color: '#f00' },
  { id: 'l2', name: 'worker', color: '#0f0' },
];

const bboxes: BboxAnnotation[] = [
  {
    id: 'left',
    kind: 'bbox',
    labelId: 'l1',
    x: 0.05,
    y: 0.2,
    width: 0.1,
    height: 0.2,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'right',
    kind: 'bbox',
    labelId: 'l1',
    x: 0.7,
    y: 0.2,
    width: 0.1,
    height: 0.2,
    createdAt: '',
    updatedAt: '',
  },
];

describe('resolveMutationTargets', () => {
  it('resolves by id', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'id', id: 'left' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['left']);
  });

  it('resolves leftmost spatial hint', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'spatial', hint: 'leftmost' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['left']);
  });

  it('uses selected ids', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'selected' }],
      labels,
      ['right'],
    );
    expect(result.ids).toEqual(['right']);
  });

  it('resolves all bboxes', () => {
    const result = resolveMutationTargets(bboxes, [{ by: 'all' }], labels, []);
    expect(result.ids.sort()).toEqual(['left', 'right']);
  });
});

describe('labelIdByName', () => {
  it('finds label case-insensitively', () => {
    expect(labelIdByName('Worker', labels)).toBe('l2');
  });
});
