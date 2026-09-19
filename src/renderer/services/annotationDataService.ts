/** IPC wrapper for `.lr-agent/annotations/` file documents */

export async function readFileAnnotationDoc(
  projectDir: string,
  relativePath: string,
): Promise<unknown | null> {
  const raw = await window.electron.annotation.readFileAnnotationDoc(
    projectDir,
    relativePath,
  );
  return raw ?? null;
}

export async function writeFileAnnotationDoc(
  projectDir: string,
  relativePath: string,
  doc: unknown,
  sourceHint?: { mtimeMs?: number; size?: number },
): Promise<void> {
  await window.electron.annotation.writeFileAnnotationDoc(
    projectDir,
    relativePath,
    doc,
    sourceHint,
  );
}

/**
 * 修复标注文档内陈旧的 `filePath`（归属真源是存储键）。
 *
 * 这些残留会让加载流水线的「就地修正」改写字节，进而使 checkpoint 的
 * `afterHash` 失配、Undo 被判定为「文件已改动」而拒绝。返回修复明细，幂等。
 */
export async function repairAnnotationDocFilePaths(
  projectDir: string,
): Promise<{
  scanned: number;
  repaired: Array<{ relativePath: string; storedFilePath: string | null }>;
}> {
  const bridge = window.electron?.annotation?.repairDocFilePaths;
  if (!bridge) return { scanned: 0, repaired: [] };
  return bridge(projectDir);
}
