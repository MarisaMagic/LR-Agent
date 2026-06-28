import type { AgentInteractionMode, ClientContextPayload } from '../../shared/agentTypes';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import type { AnnotationProject } from '../types/annotation';
import { getRelativeProjectPath } from '../utils/projectPaths';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';
import { buildAnnotationProjectSnapshot } from './buildProjectSnapshot';

export function buildClientContextPayload(options: {
  rootPath: string | null;
  activeFilePath: string | null;
  activeProject: AnnotationProject | null;
  agentMode: AgentInteractionMode;
  workMode: 'editor' | 'annotation';
  detectionModels: PretrainedModelConfig[];
  selectedAnnotationId?: string | null;
  selectedAnnotationIds?: string[];
  mcpServerUrl?: string | null;
}): ClientContextPayload {
  const activeRelativePath =
    options.activeProject && options.activeFilePath
      ? getRelativeProjectPath(
          options.activeProject.directoryPath,
          options.activeFilePath,
        )
      : null;

  const isEditorMode = options.workMode === 'editor';
  const effectiveAgentMode: AgentInteractionMode = isEditorMode
    ? 'chat'
    : options.agentMode;

  const base: ClientContextPayload = {
    workspaceRoot: options.rootPath,
    activeFilePath: options.activeFilePath,
    activeRelativePath,
    projectDirectoryPath: isEditorMode
      ? null
      : (options.activeProject?.directoryPath ?? null),
    activeAnnotationProjectId: isEditorMode
      ? null
      : (options.activeProject?.id ?? null),
    annotationProjectModality: isEditorMode
      ? null
      : (options.activeProject?.modality ?? null),
    annotationProjectType: isEditorMode
      ? null
      : (options.activeProject?.annotationType ?? null),
    agentMode: effectiveAgentMode,
    workMode: options.workMode,
    selectedAnnotationId: isEditorMode
      ? null
      : (options.selectedAnnotationId ?? null),
    selectedAnnotationIds: isEditorMode
      ? []
      : (options.selectedAnnotationIds ?? []),
    mcpServerUrl: options.mcpServerUrl ?? null,
  };

  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  if (
    !isEditorMode &&
    wsSnap.selectedAnnotationId &&
    !base.selectedAnnotationId &&
    wsSnap.workspaceProjectId === options.activeProject?.id
  ) {
    base.selectedAnnotationId = wsSnap.selectedAnnotationId;
    base.selectedAnnotationIds = wsSnap.selectedAnnotationIds.length
      ? wsSnap.selectedAnnotationIds
      : [wsSnap.selectedAnnotationId];
  }

  if (isEditorMode || !options.activeProject) return base;

  const snap = buildAnnotationProjectSnapshot(
    options.activeProject,
    options.detectionModels,
  );
  return {
    ...base,
    annotationProjectSnapshot: {
      projectId: snap.projectId,
      name: snap.name,
      directoryPath: snap.directoryPath,
      modality: snap.modality,
      annotationType: snap.annotationType,
      annotationTypeLabel: snap.annotationTypeLabel,
      labels: snap.labels,
      detectionModels: snap.detectionModels ?? [],
    },
  };
}
