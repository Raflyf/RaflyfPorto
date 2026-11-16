import React, { useEffect, useState, useRef } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Terminal } from 'lucide-react';
const Home = React.lazy(() => import('./pages/Home'));
// Dashboard is heavy (Chart.js) - code-split so the landing bundle stays light.
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
import StitchPortfolio from './stitch-ui/StitchPortfolio';
const StitchDashboard = React.lazy(() => import('./stitch-ui/StitchDashboard'));
const LegacyFloatingNavbar = React.lazy(() => import('./components/layout/LegacyFloatingNavbar'));
import { useTerminal } from './context/TerminalContext.jsx';
import { useLanguage } from './context/LanguageContext.jsx';
import { telemetry } from './lib/telemetry';
import { initLenisOnDemand, smoothScrollTo } from './lib/smooth-scroll.js';
import { subscribeScrollProgress } from './lib/scroll-progress.js';

function GlobalScrollProgressBar() {
  const barRef = useRef(null);

  useEffect(() => {
    return subscribeScrollProgress(({ progress }) => {
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${progress})`;
      }
    });
  }, []);

  return (
    <div
      ref={barRef}
      style={{ transform: 'scaleX(0)' }}
      className="fixed top-0 left-0 right-0 h-[3.5px] bg-linear-to-r from-cyan-400 via-indigo-500 to-emerald-400 z-100 origin-left shadow-[0_1px_14px_rgba(34,211,238,1),0_0_24px_rgba(99,102,241,0.7)] pointer-events-none"
    />
  );
}

function BackToTopButton({ t }) {
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    return subscribeScrollProgress(({ scrollY }) => {
      const shouldShow = scrollY > 180;
      setShowBackToTop((prev) => (prev !== shouldShow ? shouldShow : prev));
    });
  }, []);

  return (
    <button 
      onClick={() => smoothScrollTo(0, { duration: 1.2 })}
      style={{
        opacity: showBackToTop ? 1 : 0,
        transform: showBackToTop ? 'translateY(0) scale(1)' : 'translateY(16px) scale(0.65)',
        pointerEvents: showBackToTop ? 'auto' : 'none',
        transition: 'opacity 450ms cubic-bezier(0.16, 1, 0.3, 1), transform 450ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="w-12 h-12 rounded-full stitch-floating-fab-backtotop flex items-center justify-center cursor-pointer select-none will-change-[transform,opacity] text-slate-200 hover:text-white"
      aria-label={t('nav.backToTop')}
      title={t('nav.backToTop')}
    >
      <svg className="w-5 h-5 text-cyan-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 15l7-7 7 7" /></svg>
    </button>
  );
}

// Keep per-keystroke terminal updates outside the page's render tree.
function TerminalLauncher({ t }) {
  const { setIsTerminalPopupOpen } = useTerminal();
  return (
    <button
      onClick={() => {
        telemetry.logEvent('terminal_open', 'terminal_modal', 'Buka Jendela Terminal AI Modal');
        setIsTerminalPopupOpen(true);
      }}
      className="w-12 h-12 rounded-full stitch-floating-fab-terminal flex items-center justify-center cursor-pointer select-none"
      aria-label={t('nav.openTerminal')}
      title={t('nav.openTerminal')}
    >
      <Terminal className="w-5 h-5" />
    </button>
  );
}

export default function App() {
  const { t } = useLanguage();
  const location = useLocation();

  // Load smooth-wheel physics (Lenis) on demand on first wheel/scroll action so mount stays free of reflows.
  useEffect(() => initLenisOnDemand(), []);

  const prevPathnameRef = useRef(location.pathname);
  const isLegacyArchiveRoute = location.pathname.startsWith('/archive-v1');

  useEffect(() => {
    if (!isLegacyArchiveRoute && !document.documentElement.classList.contains('dark')) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    }
  }, [isLegacyArchiveRoute]);

  // Scroll to top on route change via Lenis (skip redundant scrollTo(0) on initial mount)
  useEffect(() => {
    if (prevPathnameRef.current === location.pathname) return;
    prevPathnameRef.current = location.pathname;
    smoothScrollTo(0, { immediate: true });
  }, [location.pathname]);

  // Global anchor click delegator to prevent appending '#' to browser address bar
  useEffect(() => {
    const cleanHash = () => {
      if (window.location.hash) {
        window.history.replaceState(null, '', window.location.href.split('#')[0]);
      }
    };

    // Clean hash on initial mount or whenever hash changes
    cleanHash();
    window.addEventListener('hashchange', cleanHash);

    const handleAnchorClick = (e) => {
      const anchor = e.target.closest('a[href^="#"]');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href === '#' || href.length <= 1) return;

      e.preventDefault();
      const targetId = href.slice(1);
      const targetEl = document.getElementById(targetId);

      if (targetEl) {
        smoothScrollTo(targetEl, { duration: 1.2, offset: -70 });
      }

      // Ensure clean URL without hash
      cleanHash();
    };

    document.addEventListener('click', handleAnchorClick);
    return () => {
      window.removeEventListener('hashchange', cleanHash);
      document.removeEventListener('click', handleAnchorClick);
    };
  }, [location]);

  return (
    <>
        {/* Root-Level Unobstructed Scroll Progress Bar (z-[100] always floats above navbar) */}
        <GlobalScrollProgressBar />

        <div className="min-h-screen bg-background dark:bg-zinc-950 text-foreground relative selection:bg-cyan-500/20 font-sans">
          {isLegacyArchiveRoute && (
            <React.Suspense fallback={null}>
              <LegacyFloatingNavbar />
            </React.Suspense>
          )}

          <Routes>
            <Route
              path="/"
              element={<StitchPortfolio />}
            />
            <Route
              path="/dashboard"
              element={
                <React.Suspense fallback={
                  <div className="min-h-screen flex items-center justify-center bg-[#06080d]">
                    <div className="w-9 h-9 rounded-full border-2 border-cyan-500/40 border-t-cyan-400 animate-spin" aria-label="Memuat Dashboard" />
                  </div>
                }>
                  <StitchDashboard />
                </React.Suspense>
              }
            />
            <Route
              path="/archive-v1"
              element={
                <React.Suspense fallback={
                  <div className="min-h-screen flex items-center justify-center bg-[#06080d]">
                    <div className="w-9 h-9 rounded-full border-2 border-cyan-500/40 border-t-cyan-400 animate-spin" aria-label="Memuat Archive V1" />
                  </div>
                }>
                  <Home />
                </React.Suspense>
              }
            />
            <Route
              path="/archive-v1/dashboard"
              element={
                <React.Suspense fallback={
                  <div className="min-h-screen flex items-center justify-center bg-background dark:bg-zinc-950">
                    <div className="w-9 h-9 rounded-full border-2 border-cyan-500/40 border-t-cyan-400 animate-spin" aria-label="Memuat Dashboard V1" />
                  </div>
                }>
                  <Dashboard isStitch={false} />
                </React.Suspense>
              }
            />
            {/* Backwards compatibility aliases for preview links */}
            <Route
              path="/preview-stitch"
              element={<StitchPortfolio />}
            />
            <Route
              path="/preview-stitch/dashboard"
              element={
                <React.Suspense fallback={
                  <div className="min-h-screen flex items-center justify-center bg-[#06080d]">
                    <div className="w-9 h-9 rounded-full border-2 border-cyan-500/40 border-t-cyan-400 animate-spin" aria-label="Memuat Stitch Dashboard" />
                  </div>
                }>
                  <StitchDashboard />
                </React.Suspense>
              }
            />
          </Routes>
        
          {/* Floating Action Buttons */}
          {!location.pathname.includes('dashboard') && (
            <div
              className="fixed bottom-6 right-6 z-50 flex flex-col items-center gap-3"
              style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
            >
              <BackToTopButton t={t} />
              
              <TerminalLauncher t={t} />
            </div>
          )}
        </div>
    </>
  );
}
