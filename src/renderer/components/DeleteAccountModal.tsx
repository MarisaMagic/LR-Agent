import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FormEvent, useState } from 'react';
import PasswordField from '../pages/PasswordField';
import ModalMotion from '../motion/ModalMotion';
import { motionDistance, motionDuration, motionEase } from '../motion/tokens';
import './DeleteAccountModal.css';

type DeleteStep = 'confirm' | 'password';

interface DeleteAccountModalProps {
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
}

export default function DeleteAccountModal({
  onCancel,
  onConfirm,
}: DeleteAccountModalProps) {
  const [step, setStep] = useState<DeleteStep>('confirm');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  const stepVariants = {
    initial: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: motionDistance.y / 2 },
    animate: { opacity: 1, y: 0 },
    exit: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: -motionDistance.y / 2 },
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request_failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalMotion
      open
      onClose={onCancel}
      dialogClassName="delete-account-dialog"
      dialogRole={step === 'password' ? 'form' : 'dialog'}
      labelledBy={
        step === 'confirm'
          ? 'delete-account-title'
          : 'delete-account-password-title'
      }
      onSubmit={step === 'password' ? handleSubmit : undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        {step === 'confirm' ? (
          <motion.div
            key="confirm"
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{
              duration: reducedMotion ? 0.1 : motionDuration.tab,
              ease: motionEase,
            }}
          >
            <h3 id="delete-account-title" className="delete-account-title">
              确认注销账号？
            </h3>
            <p className="delete-account-hint">
              注销后你的账号将被停用，所有设备上的登录都会失效，原邮箱可以重新注册。此操作不可撤销。
            </p>
            <div className="delete-account-actions">
              <button
                type="button"
                className="app-btn app-btn-secondary"
                onClick={onCancel}
              >
                取消
              </button>
              <button
                type="button"
                className="app-btn app-btn-danger"
                onClick={() => setStep('password')}
              >
                继续注销
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="password"
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{
              duration: reducedMotion ? 0.1 : motionDuration.tab,
              ease: motionEase,
            }}
          >
            <h3
              id="delete-account-password-title"
              className="delete-account-title"
            >
              验证身份
            </h3>
            <p className="delete-account-hint">请输入当前密码以完成注销。</p>

            <PasswordField
              id="delete-account-password"
              name="password"
              label="当前密码"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
            />

            {error && <p className="delete-account-error">{error}</p>}

            <div className="delete-account-actions">
              <button
                type="button"
                className="app-btn app-btn-secondary"
                onClick={() => {
                  setError(null);
                  setPassword('');
                  setStep('confirm');
                }}
                disabled={loading}
              >
                返回
              </button>
              <button
                type="submit"
                className="app-btn app-btn-danger"
                disabled={loading}
              >
                {loading ? '注销中…' : '确认注销'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </ModalMotion>
  );
}
