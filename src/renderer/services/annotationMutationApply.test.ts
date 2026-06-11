import {
  checkSourceFreshness,
  validateMutations,
} from './annotationMutationApply';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import type { FileAnnotationDocument } from '../types/annotationDocument';

const labels = [{ id: 'l1', name: 'person', color: '#f00' }];

const doc: FileAnnotationDocument = {
  schemaVersion: 1,
  projectId: 'p1',
  filePath: 'data/1.jpg',
  modality: 'image',
  annotationType: 'bbox',
  annotations: [
    {
      id: 'a1',
      kind: 'bbox',
      labelId: 'l1',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    },
  ],
  updatedAt: '2020-01-01T00:00:00.000Z',
};

describe('validateMutations', () => {
  it('accepts patch with valid id and label', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'patch',
      patches: [{ id: 'a1', labelId: 'l1' }],
    };
    const result = validateMutations(doc, change, labels);
    expect(result.valid).toBe(true);
  });

  it('rejects delete for missing id', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'delete',
      deleteIds: ['missing'],
    };
    const result = validateMutations(doc, change, labels);
    expect(result.valid).toBe(false);
  });
});

describe('checkSourceFreshness', () => {
  it('detects mtime change', () => {
    const result = checkSourceFreshness(
      { mtimeMs: 100, size: 50 },
      { mtimeMs: 200, size: 50 },
    );
    expect(result.fresh).toBe(false);
  });
});
