import { useState } from 'react';
import {
  VscodeButton,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import ModalMotion from '../../motion/ModalMotion';
import {
  buildEmptyProvider,
  useLlmProviders,
} from '../../context/LlmProvidersContext';
import type { LlmProviderConfig } from '../../types/agent';
import LlmProviderFormModal from './LlmProviderFormModal';
import LlmProviderList from './LlmProviderList';
import './LlmProvidersPanel.css';

export default function LlmProvidersPanel() {
  const {
    providers,
    loading,
    refreshProviders,
    upsertProvider,
    deleteProvider,
    setDefaultProvider,
    probeProviderVision,
  } = useLlmProviders();

  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<LlmProviderConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderConfig | null>(
    null,
  );

  const openCreate = () => {
    setEditingProvider(buildEmptyProvider());
    setFormOpen(true);
  };

  const openEdit = (provider: LlmProviderConfig) => {
    setEditingProvider({ ...provider, apiKey: '' });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingProvider(null);
  };

  const handleSave = async (provider: LlmProviderConfig) => {
    const existing = providers.find((item) => item.id === provider.id);
    const isNew = !existing;
    await upsertProvider(provider, isNew);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteProvider(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="llm-providers-panel">
      <VscodeToolbarContainer className="llm-providers-toolbar">
        <VscodeClickableToolbarButton
          icon="add"
          label="添加大模型配置"
          onClick={openCreate}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshProviders()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="llm-providers-scroll-host"
        scrollableClassName="llm-providers-scrollable"
      >
        <LlmProviderList
          providers={providers}
          loading={loading}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          onSetDefault={(provider) => setDefaultProvider(provider.id)}
          onProbeVision={(provider) => probeProviderVision(provider.id)}
        />
      </VscodeScrollHost>

      {formOpen && editingProvider && (
        <LlmProviderFormModal
          open
          initial={editingProvider}
          isNew={!providers.some((item) => item.id === editingProvider.id)}
          onClose={closeForm}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ModalMotion
          open
          onClose={() => setDeleteTarget(null)}
          dialogClassName="llm-provider-delete-dialog"
          labelledBy="llm-provider-delete-title"
        >
          <h3 id="llm-provider-delete-title">删除大模型配置？</h3>
          <p>将删除配置「{deleteTarget.name || deleteTarget.model}」。</p>
          <div className="llm-provider-delete-actions">
            <VscodeButton
              secondary
              icon="close"
              type="button"
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </VscodeButton>
            <VscodeButton
              secondary
              icon="trash"
              type="button"
              className="vscode-btn-danger"
              onClick={handleDelete}
            >
              删除
            </VscodeButton>
          </div>
        </ModalMotion>
      )}
    </div>
  );
}
