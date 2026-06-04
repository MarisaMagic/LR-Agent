import type { ImageCandidate } from '../../../shared/annotationAgentTypes';

function catalogToCandidate(
  entry: {
    relativePath: string;
    name: string;
    parent: string;
    absolutePath: string;
    index: number;
  },
): ImageCandidate {
  return {
    relativePath: entry.relativePath,
    name: entry.name,
    parent: entry.parent,
    absolutePath: entry.absolutePath,
    index: entry.index,
  };
}

export async function executeScopeFsTool(
  projectDir: string,
  name: string,
  args: Record<string, unknown>,
  knownImages: Map<string, ImageCandidate>,
): Promise<string> {
  const agent = window.electron?.annotationAgent;
  if (!agent) {
    return JSON.stringify({ error: 'annotationAgent IPC 不可用' });
  }

  if (name === 'glob_project_images') {
    const parentFolder = String(args.parent_folder ?? args.parentFolder ?? '');
    const namePattern = String(args.name_pattern ?? args.namePattern ?? '');
    const limit = Number(args.limit ?? 100);
    const result = await agent.globImages(projectDir, {
      parentFolder,
      namePattern,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    for (const img of result.images) {
      knownImages.set(img.relativePath, catalogToCandidate(img));
    }
    return JSON.stringify({
      count: result.count,
      images: result.images.map((i) => ({
        relative_path: i.relativePath,
        name: i.name,
        parent: i.parent,
        index: i.index,
      })),
    });
  }

  if (name === 'list_project_directory') {
    const relativeDir = String(args.relative_dir ?? args.relativeDir ?? '');
    const maxEntries = Number(args.max_entries ?? args.maxEntries ?? 80);
    const result = await agent.listDirectory(
      projectDir,
      relativeDir,
      Number.isFinite(maxEntries) ? maxEntries : 80,
    );
    return JSON.stringify(result);
  }

  if (name === 'select_annotation_images') {
    const rawPaths = args.selected_paths ?? args.selectedPaths;
    const paths = Array.isArray(rawPaths)
      ? rawPaths
          .map((p) => String(p).trim().replace(/\\/g, '/'))
          .filter(Boolean)
      : [];
    const reason = String(args.reason ?? '');
    for (const p of paths) {
      if (!knownImages.has(p)) {
        // 路径可能来自 list_directory，稍后由 runner 解析绝对路径
      }
    }
    return JSON.stringify({
      ok: true,
      selected_paths: paths,
      reason,
    });
  }

  return JSON.stringify({ error: `未知工具: ${name}` });
}
