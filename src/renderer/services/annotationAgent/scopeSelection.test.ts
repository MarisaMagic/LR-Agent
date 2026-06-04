import { describe, expect, it } from '@jest/globals';
import type { ImageCandidate } from '../../../shared/annotationAgentTypes';
import { imagesFromAgentPaths } from './scopeSelection';

const candidates: ImageCandidate[] = [
  {
    relativePath: 'data/7.jpg',
    name: '7.jpg',
    parent: 'data',
    absolutePath: '/p/data/7.jpg',
    index: 0,
  },
  {
    relativePath: 'data/8.jpg',
    name: '8.jpg',
    parent: 'data',
    absolutePath: '/p/data/8.jpg',
    index: 1,
  },
];

describe('imagesFromAgentPaths', () => {
  it('maps agent selected paths to catalog entries', () => {
    const { images, missing } = imagesFromAgentPaths(
      candidates,
      ['data/7.jpg', 'data/8.jpg'],
      100,
    );
    expect(missing).toEqual([]);
    expect(images.map((i) => i.relativePath)).toEqual(['data/7.jpg', 'data/8.jpg']);
  });

  it('reports missing paths', () => {
    const { images, missing } = imagesFromAgentPaths(
      candidates,
      ['data/9.jpg'],
      100,
    );
    expect(images).toEqual([]);
    expect(missing).toEqual(['data/9.jpg']);
  });
});
