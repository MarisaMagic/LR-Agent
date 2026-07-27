import { describe, expect, it } from '@jest/globals';
import {
  buildLabeledAnnotationsFromMappings,
  tryAutoFinalizeFromMap,
} from './finalizeFromMappings';
import type { BatchAnnotationPlan } from '../../../shared/annotationAgentTypes';

const plan: BatchAnnotationPlan = {
  intent_summary: 'test',
  label_strategy: 'map_each_box_to_label',
  use_vision_mapping: true,
  detection_hints: {},
  sub_agent_constraints: {
    allow_unlabeled_boxes: true,
    min_labeled_box_count: 1,
  },
  annotation_scope: {},
  plan_steps: [],
};

const boxes = [
  {
    box_index: 0,
    class_name: 'person',
    confidence: 0.9,
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.3,
  },
  {
    box_index: 1,
    class_name: 'person',
    confidence: 0.85,
    x: 0.5,
    y: 0.1,
    width: 0.2,
    height: 0.3,
  },
];

const labels = [
  { id: 'l1', name: 'curry' },
  { id: 'l2', name: 'james' },
];

describe('buildLabeledAnnotationsFromMappings', () => {
  it('keeps unlabeled boxes with labelId null when allow_unlabeled_boxes', () => {
    const annotations = buildLabeledAnnotationsFromMappings(
      boxes,
      [
        { box_index: 0, label_id: 'l1' },
        { box_index: 1, label_id: '' },
      ],
      new Set(['l1', 'l2']),
      { allowUnlabeledBoxes: true },
    );
    expect(annotations).toHaveLength(2);
    expect(annotations[0].labelId).toBe('l1');
    expect(annotations[1].labelId).toBeNull();
  });

  it('drops unlabeled boxes when allow_unlabeled_boxes is false', () => {
    const annotations = buildLabeledAnnotationsFromMappings(
      boxes,
      [
        { box_index: 0, label_id: 'l1' },
        { box_index: 1, label_id: '' },
      ],
      new Set(['l1', 'l2']),
      { allowUnlabeledBoxes: false },
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0].labelId).toBe('l1');
  });
});

describe('tryAutoFinalizeFromMap', () => {
  it('succeeds with partial labels when min_labeled satisfied', () => {
    const result = tryAutoFinalizeFromMap({
      plan,
      imageRelativePath: 'data/1.jpg',
      imageAbsolutePath: '/proj/data/1.jpg',
      boxes,
      mappings: [
        { box_index: 0, label_id: 'l1', reason: 'curry' },
        { box_index: 1, label_id: '', reason: '不确定' },
      ],
      labelCandidates: labels,
    });
    expect(result.ok).toBe(true);
    expect(result.mappedCount).toBe(1);
    expect(result.unlabeledInProposal).toBe(1);
    expect(result.change?.annotations).toHaveLength(2);
  });

  it('fails when no labeled boxes', () => {
    const result = tryAutoFinalizeFromMap({
      plan,
      imageRelativePath: 'data/1.jpg',
      imageAbsolutePath: '/proj/data/1.jpg',
      boxes,
      mappings: [
        { box_index: 0, label_id: '', reason: '' },
        { box_index: 1, label_id: '', reason: '' },
      ],
      labelCandidates: labels,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('无有效 label_id 映射');
  });
});
