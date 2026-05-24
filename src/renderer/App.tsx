import {
  BrowserRouter,
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import AppShell from './components/AppShell';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import AuthPage from './pages/AuthPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import MotionProvider from './motion/MotionProvider';
import PageTransition from './motion/PageTransition';
import './vscode-setup';
import './App.css';

function MainAppRoutes() {
  const location = useLocation();

  return (
    <AuthProvider>
      <ToastProvider>
        <AppProvider>
          <AppShell>
            <PageTransition routeKey={location.pathname} className="app-shell-transition">
              <Routes location={location}>
                <Route path="/auth" element={<AuthPage />} />
                <Route element={<RequireAuth />}>
                  <Route path="/" element={<Layout />} />
                </Route>
              </Routes>
            </PageTransition>
          </AppShell>
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

export default function App() {
  const isElectron = Boolean(window.electron?.platform);
  const isHttpApp =
    !isElectron &&
    (window.location.protocol === 'http:' ||
      window.location.protocol === 'https:');
  const Router = isHttpApp ? BrowserRouter : MemoryRouter;

  return (
    <MotionProvider>
      <Router>
        <AppRoutes />
      </Router>
    </MotionProvider>
  );
}
