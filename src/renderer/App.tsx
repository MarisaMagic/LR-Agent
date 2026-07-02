import {
  BrowserRouter,
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import React, { useCallback, useEffect, useState } from 'react';
import AppShell from './components/AppShell';
import { AppProvider } from './context/AppContext';
import { AnnotationProvider } from './context/AnnotationContext';
import { WorkModeProvider } from './context/WorkModeContext';
import { AnnotationWorkspaceProvider } from './context/AnnotationWorkspaceContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import AuthPage from './pages/AuthPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import MotionProvider from './motion/MotionProvider';
import PageTransition from './motion/PageTransition';
import { PretrainedModelsProvider } from './context/PretrainedModelsContext';
import { LlmProvidersProvider } from './context/LlmProvidersContext';
import { AgentChatProvider } from './context/AgentChatContext';
import { ThemeProvider } from './context/ThemeContext';
import DataMigrationDialog from './components/DataMigrationDialog';
import { checkNeedsMigration } from './services/dataMigration';
import tokenHolder from './services/tokenHolder';
import './vscode-setup';
import './App.css';

function MainAppRoutes() {
  const location = useLocation();

  return (
    <AuthProvider>
      <ToastProvider>
        <AppProvider>
          <PretrainedModelsProvider>
            <LlmProvidersProvider>
              <AnnotationProvider>
                <WorkModeProvider>
                <AgentChatProvider>
                  <AnnotationWorkspaceProvider>
                    <MigrationGuard>
                      <AppShell>
                        <PageTransition
                          routeKey={location.pathname}
                          className="app-shell-transition"
                        >
                          <Routes location={location}>
                            <Route path="/auth" element={<AuthPage />} />
                            <Route element={<RequireAuth />}>
                              <Route path="/" element={<Layout />} />
                            </Route>
                          </Routes>
                        </PageTransition>
                      </AppShell>
                    </MigrationGuard>
                  </AnnotationWorkspaceProvider>
                </AgentChatProvider>
                </WorkModeProvider>
              </AnnotationProvider>
            </LlmProvidersProvider>
          </PretrainedModelsProvider>
        </AppProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function AppRoutes() {
  const location = useLocation();

  return (
    <Routes location={location}>
      <Route
        path="/verify"
        element={
          <PageTransition routeKey="/verify">
            <VerifyEmailPage />
          </PageTransition>
        }
      />
      <Route path="*" element={<MainAppRoutes />} />
    </Routes>
  );
}

function MigrationGuard({ children }: { children: React.ReactNode }) {
  const { authStatus } = useAuth();
  const [showMigration, setShowMigration] = useState(false);

  useEffect(() => {
    if (authStatus === 'authenticated') {
      // Only check for migration if user is authenticated and has remote data
      checkNeedsMigration().then((needs) => {
        if (needs) {
          setShowMigration(true);
        }
      });
    }
  }, [authStatus]);

  const handleMigrationComplete = useCallback(() => {
    setShowMigration(false);
  }, []);

  if (showMigration) {
    return <DataMigrationDialog onComplete={handleMigrationComplete} />;
  }

  return <>{children}</>;
}

export default function App() {
  const isElectron = Boolean(window.electron?.platform);
  const isHttpApp =
    !isElectron &&
    (window.location.protocol === 'http:' ||
      window.location.protocol === 'https:');
  const Router = isHttpApp ? BrowserRouter : MemoryRouter;

  return (
    <ThemeProvider>
      <MotionProvider>
        <Router>
          <AppRoutes />
        </Router>
      </MotionProvider>
    </ThemeProvider>
  );
}
