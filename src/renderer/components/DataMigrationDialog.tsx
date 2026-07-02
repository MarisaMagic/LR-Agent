import React, { useCallback, useEffect, useState } from 'react';
import { checkNeedsMigration, migrateFromBackend, clearRemoteData } from '../services/dataMigration';
import tokenHolder from '../services/tokenHolder';

interface DataMigrationDialogProps {
  onComplete: () => void;
}

type MigrationPhase = 'checking' | 'migrating' | 'clearing' | 'done' | 'error' | 'skipped';

export default function DataMigrationDialog({ onComplete }: DataMigrationDialogProps) {
  const [phase, setPhase] = useState<MigrationPhase>('checking');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState<{ migrated: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearEnabled, setClearEnabled] = useState(false);

  const startMigration = useCallback(async () => {
    try {
      // Phase 1: check if migration is needed
      setPhase('checking');
      const needsMigration = await checkNeedsMigration();
      if (!needsMigration) {
        setPhase('skipped');
        return;
      }

      // Phase 2: migrate
      setPhase('migrating');
      const res = await migrateFromBackend((current, total) => {
        setProgress({ current, total });
      });
      setResult(res);

      if (res.errors > 0 && res.migrated === 0) {
        setPhase('error');
        setError('迁移失败，所有会话迁移出错');
        return;
      }

      // Phase 3: offer to clear remote data
      setPhase('clearing');
      setClearEnabled(true);
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : '迁移过程发生未知错误');
    }
  }, []);

  const handleClear = useCallback(async () => {
    setPhase('clearing');
    await clearRemoteData();
    setPhase('done');
  }, []);

  const handleSkipClear = useCallback(() => {
    setPhase('done');
  }, []);

  useEffect(() => {
    // Only auto-start if user is authenticated
    if (tokenHolder.getAccessToken()) {
      startMigration();
    } else {
      setPhase('skipped');
    }
  }, [startMigration]);

  // Auto-complete after done phase
  useEffect(() => {
    if (phase === 'done' || phase === 'skipped') {
      const timer = setTimeout(onComplete, 1500);
      return () => clearTimeout(timer);
    }
  }, [phase, onComplete]);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
      zIndex: 9999,
    }}>
      <div style={{
        maxWidth: 480,
        width: '100%',
        padding: 32,
        textAlign: 'center',
      }}>
        <h2 style={{ marginBottom: 24, fontSize: 20, color: 'var(--vscode-foreground, #ccc)' }}>
          数据迁移
        </h2>

        {phase === 'checking' && (
          <p style={{ color: 'var(--vscode-descriptionForeground, #999)' }}>
            正在检查是否有历史对话需要迁移...
          </p>
        )}

        {phase === 'migrating' && (
          <>
            <p style={{ color: 'var(--vscode-descriptionForeground, #999)', marginBottom: 16 }}>
              正在迁移历史对话到本地存储...
            </p>
            <div style={{
              height: 6,
              backgroundColor: 'var(--vscode-progressBar-background, #333)',
              borderRadius: 3,
              overflow: 'hidden',
              marginBottom: 8,
            }}>
              <div style={{
                height: '100%',
                width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                backgroundColor: 'var(--vscode-progressBar-foreground, #007acc)',
                transition: 'width 0.3s ease',
                borderRadius: 3,
              }} />
            </div>
            <span style={{ fontSize: 13, color: 'var(--vscode-descriptionForeground, #999)' }}>
              已处理 {progress.current} / {progress.total} 个对话
            </span>
          </>
        )}

        {phase === 'clearing' && (
          <>
            <p style={{ color: 'var(--vscode-descriptionForeground, #999)', marginBottom: 16 }}>
              {result
                ? `迁移完成。成功 ${result.migrated} 个会话${result.errors > 0 ? `，${result.errors} 个失败` : ''}。`
                : '迁移完成。'}
            </p>
            <p style={{ color: 'var(--vscode-descriptionForeground, #999)', marginBottom: 24, fontSize: 13 }}>
              是否清除服务器上的对话数据？（强烈建议清除以保护隐私）
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={handleClear}
                style={{
                  padding: '8px 20px',
                  backgroundColor: 'var(--vscode-button-background, #007acc)',
                  color: 'var(--vscode-button-foreground, #fff)',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                清除服务端数据
              </button>
              <button
                onClick={handleSkipClear}
                style={{
                  padding: '8px 20px',
                  backgroundColor: 'transparent',
                  color: 'var(--vscode-foreground, #ccc)',
                  border: '1px solid var(--vscode-button-border, #555)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                跳过
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p style={{ color: 'var(--vscode-errorForeground, #f44747)', marginBottom: 16 }}>
              {error || '迁移失败'}
            </p>
            <button
              onClick={onComplete}
              style={{
                padding: '8px 20px',
                backgroundColor: 'var(--vscode-button-background, #007acc)',
                color: 'var(--vscode-button-foreground, #fff)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              继续使用
            </button>
          </>
        )}

        {phase === 'skipped' && (
          <p style={{ color: 'var(--vscode-descriptionForeground, #999)' }}>
            无需迁移
          </p>
        )}

        {phase === 'done' && (
          <p style={{ color: 'var(--vscode-descriptionForeground, #999)' }}>
            迁移完成，正在进入应用...
          </p>
        )}
      </div>
    </div>
  );
}
