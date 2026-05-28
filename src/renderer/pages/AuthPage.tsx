import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { motionDistance, motionDuration, motionEase } from '../motion/tokens';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';
import './AuthPage.css';

type AuthTab = 'login' | 'register';

function AuthLoadingCard() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="auth-card"
      initial={
        reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionDistance.y }
      }
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionDuration.enter, ease: motionEase }}
    >
      <p>正在加载…</p>
    </motion.div>
  );
}

export default function AuthPage() {
  const { status } = useAuth();
  const [tab, setTab] = useState<AuthTab>('login');
  const reducedMotion = useReducedMotion();

  if (status === 'loading') {
    return (
      <div className="auth-page">
        <AuthLoadingCard />
      </div>
    );
  }

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  const loginVariants = {
    initial: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, x: -motionDistance.x },
    animate: { opacity: 1, x: 0 },
    exit: reducedMotion ? { opacity: 0 } : { opacity: 0, x: motionDistance.x },
  };

  const registerVariants = {
    initial: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, x: motionDistance.x },
    animate: { opacity: 1, x: 0 },
    exit: reducedMotion ? { opacity: 0 } : { opacity: 0, x: -motionDistance.x },
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-brand">LR-Agent</h1>
        <p className="auth-subtitle">登录或注册以继续使用</p>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${tab === 'login' ? 'auth-tab-active' : ''}`}
            onClick={() => setTab('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={`auth-tab ${tab === 'register' ? 'auth-tab-active' : ''}`}
            onClick={() => setTab('register')}
          >
            注册
          </button>
        </div>

        <div className="auth-form-stack">
          <AnimatePresence mode="wait" initial={false}>
            {tab === 'login' ? (
              <motion.div
                key="login"
                className="auth-form-pane"
                variants={loginVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{
                  duration: reducedMotion ? 0.1 : motionDuration.tab,
                  ease: motionEase,
                }}
              >
                <LoginForm onSwitchToRegister={() => setTab('register')} />
              </motion.div>
            ) : (
              <motion.div
                key="register"
                className="auth-form-pane"
                variants={registerVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{
                  duration: reducedMotion ? 0.1 : motionDuration.tab,
                  ease: motionEase,
                }}
              >
                <RegisterForm onSwitchToLogin={() => setTab('login')} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
