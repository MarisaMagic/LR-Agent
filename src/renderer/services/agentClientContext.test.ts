import { describe, expect, it, jest } from '@jest/globals';
import { buildClientContextPayload } from './agentClientContextBuilder';
import type { AnnotationProject } from '../types/annotation';

jest.mock('./annotationAgentBridge', () => ({
  getAnnotationWorkspaceAgentSnapshot: () => ({
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    workspaceProjectId: null,
  }),
}));

const sampleProject: AnnotationProject = {
  id: 'proj-1',
  name: 'Demo',
  directoryPath: '/tmp/project',
  modality: 'image',
  annotationType: 'bbox',
  labels: [{ id: 'l1', name: 'cat', color: '#f00' }],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('buildClientContextPayload', () => {
  it('omits annotation snapshot in editor work mode', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.jpg',
      activeProject: sampleProject,
      agentMode: 'annotation',
      workMode: 'editor',
      detectionModels: [],
    });

    expect(payload.workMode).toBe('editor');
    expect(payload.agentMode).toBe('chat');
    expect(payload.annotationProjectSnapshot).toBeUndefined();
    expect(payload.activeAnnotationProjectId).toBeNull();
  });

  it('includes annotation snapshot in annotation work mode', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.jpg',
      activeProject: sampleProject,
      agentMode: 'annotation',
      workMode: 'annotation',
      detectionModels: [],
    });

    expect(payload.annotationProjectSnapshot?.projectId).toBe('proj-1');
    expect(payload.activeAnnotationProjectId).toBe('proj-1');
  });
});
