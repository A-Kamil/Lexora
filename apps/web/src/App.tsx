import { useState } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useOutlet,
} from 'react-router-dom';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { BackendUnreachableBanner } from './components/BackendUnreachableBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UrgentCasesBar } from './components/UrgentCasesBar';
import { useHealthProbe } from './hooks/useHealthProbe';
import { CaseDetailPage } from './pages/CaseDetail';
import { CasesPage } from './pages/Cases';
import { LandingPage } from './pages/Landing';
import { LoginPage } from './pages/Login';
import { getSession } from './lib/session';
import { CasesProvider } from './state/CasesProvider';

const HEALTH_DISMISSED_KEY = 'lexora.healthBannerDismissed';

function RequireAuth({ children }: { children: React.ReactNode }) {
  return getSession() ? <>{children}</> : <Navigate to="/connexion" replace />;
}

/** Probes the data source once per visit to the authenticated area. */
function DataSourceBanner() {
  const { status, retry } = useHealthProbe();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(HEALTH_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (status !== 'unreachable' || dismissed) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(HEALTH_DISMISSED_KEY, '1');
    } catch {
      /* storage disabled — dismissal stays local to this component */
    }
    setDismissed(true);
  };

  const retryNow = () => {
    try {
      sessionStorage.removeItem(HEALTH_DISMISSED_KEY);
    } catch {
      /* ignore */
    }
    setDismissed(false);
    retry();
  };

  return <BackendUnreachableBanner onRetry={retryNow} onDismiss={dismiss} />;
}

/** Short fade between screens; disabled automatically for reduced motion. */
function FadeOutlet() {
  const location = useLocation();
  const outlet = useOutlet();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        style={{ minHeight: '100svh' }}
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * The banners live OUTSIDE the fading outlet: if the urgent-case bar unmounted
 * during a transition, the lawyer could read that as "alert cleared".
 */
function AuthedLayout() {
  return (
    <RequireAuth>
      <CasesProvider>
        <DataSourceBanner />
        <UrgentCasesBar />
        <FadeOutlet />
      </CasesProvider>
    </RequireAuth>
  );
}

const router = createBrowserRouter([
  {
    element: <Outlet />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/connexion', element: <LoginPage /> },
      {
        element: <AuthedLayout />,
        children: [
          { path: '/dossiers', element: <CasesPage /> },
          { path: '/dossiers/:caseId', element: <CaseDetailPage /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}>
        <RouterProvider router={router} />
      </MotionConfig>
    </ErrorBoundary>
  );
}
