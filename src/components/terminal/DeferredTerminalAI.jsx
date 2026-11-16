import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../../context/TerminalContext.jsx';

const LazyTerminalAI = React.lazy(() => import('./TerminalAI.jsx'));

function TerminalPopupObserver({ onOpen }) {
  const { isTerminalPopupOpen } = useTerminal();
  useEffect(() => {
    if (isTerminalPopupOpen) onOpen();
  }, [isTerminalPopupOpen, onOpen]);
  return null;
}

function TerminalShellFallback() {
  return (
    <div
      role="region"
      className="w-full max-w-5xl mx-auto h-135 sm:h-150 lg:h-175 rounded-2xl sm:rounded-3xl stitch-terminal-window flex items-center justify-center"
      aria-busy="true"
      aria-label="Memuat Terminal AI"
    >
      <div className="w-8 h-8 rounded-full border-2 border-cyan-500/40 border-t-cyan-400 animate-spin" aria-hidden="true" />
    </div>
  );
}

/**
 * Defers loading the heavy TerminalAI + Markdown chunk until the #lab section
 * approaches the viewport, is targeted by hash, or the popup FAB is opened.
 */
export default function DeferredTerminalAI({ eagerComponent: EagerComponent = null }) {
  const hostRef = useRef(null);
  const [shouldLoad, setShouldLoad] = useState(() => Boolean(EagerComponent));

  useEffect(() => {
    if (shouldLoad) return;

    if (typeof window !== 'undefined') {
      const target = window.__initialTargetHash || window.location.hash.replace('#', '');
      if (target === 'lab') {
        setShouldLoad(true);
        return;
      }
    }

    const onAnchorClick = (e) => {
      const link = e.target?.closest?.('a[href="#lab"], a[href="/#lab"]');
      if (link) setShouldLoad(true);
    };
    document.addEventListener('click', onAnchorClick, true);

    const el = hostRef.current;
    let observer = null;
    if (el && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setShouldLoad(true);
            observer?.disconnect();
          }
        },
        { rootMargin: '800px 0px' }
      );
      observer.observe(el);
    } else {
      setShouldLoad(true);
    }

    return () => {
      document.removeEventListener('click', onAnchorClick, true);
      observer?.disconnect();
    };
  }, [shouldLoad]);

  if (EagerComponent) {
    return <EagerComponent />;
  }

  return (
    <div ref={hostRef} className="w-full">
      {!shouldLoad && <TerminalPopupObserver onOpen={() => setShouldLoad(true)} />}
      {shouldLoad ? (
        <Suspense fallback={<TerminalShellFallback />}>
          <LazyTerminalAI />
        </Suspense>
      ) : (
        <TerminalShellFallback />
      )}
    </div>
  );
}
