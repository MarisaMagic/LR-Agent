import {
  checkSourceFreshness,
  mergeProposalChangesIntoDoc,
  validateMutations,
} from './annotationMutationApply';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import type { FileAnnotationDocument } from '../types/annotationDocument';
import type { AnnotationProject } from '../types/annotation';

const labels = [{ id: 'l1', name: 'person', color: '#f00' }];

const project: AnnotationProject = {
  id: 'p1',
  name: 'Demo',
  directoryPath: '/tmp/project',
  modality: 'image',
  annotationType: 'bbox',
  labels,
  createdAt: '',
  updatedAt: '',
};

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

describe('mergeProposalChangesIntoDoc', () => {
  it('appends multiple changes for the same file', () => {
    const append1: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'a2',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.2,
          y: 0.2,
          width: 0.1,
          height: 0.1,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const append2: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'a3',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.3,
          y: 0.3,
          width: 0.1,
          height: 0.1,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(
      doc,
      [append1, append2],
      project,
    );
    expect(merged.annotations).toHaveLength(3);
    expect(merged.annotations.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('replace_bboxes keeps non-bbox annotations', () => {
    const docWithCaption: FileAnnotationDocument = {
      ...doc,
      annotations: [
        ...doc.annotations,
        {
          id: 'c1',
          kind: 'caption',
          labelId: null,
          text: 'hello',
          granularity: 'brief',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'replace_bboxes',
      annotations: [
        {
          id: 'b2',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.5,
          y: 0.5,
          width: 0.2,
          height: 0.2,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(
      docWithCaption,
      [change],
      project,
    );
    expect(merged.annotations).toHaveLength(2);
    expect(merged.annotations.some((a) => a.id === 'c1')).toBe(true);
    expect(merged.annotations.some((a) => a.id === 'b2')).toBe(true);
    expect(merged.annotations.some((a) => a.id === 'a1')).toBe(false);
  });

  it('creates a new doc when parsed is null and changes are append-only', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/new.jpg',
      absolutePath: '/tmp/data/new.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'n1',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(null, [change], project);
    expect(merged.filePath).toBe('data/new.jpg');
    expect(merged.annotations).toHaveLength(1);
    expect(merged.annotations[0]?.id).toBe('n1');
  });
});
