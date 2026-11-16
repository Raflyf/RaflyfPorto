import React, { useRef, useMemo, useState, useEffect } from 'react';
import { getTimelineData } from '../../data';
import { useLanguage } from '../../context/LanguageContext';
import { Briefcase, GraduationCap } from 'lucide-react';
import Reveal from '../ui/Reveal.jsx';
import { subscribeScrollProgress } from '../../lib/scroll-progress.js';

function TimelineProgressBeam({ containerRef }) {
  const beamRef = useRef(null);
  const boundsRef = useRef({ top: 0, height: 1, winH: 0 });

  useEffect(() => {
    const measureBounds = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      boundsRef.current = {
        top: rect.top + (window.scrollY || 0),
        height: Math.max(1, rect.height),
        winH: window.innerHeight || 0,
      };
    };

    const updateBeam = (scrollY) => {
      if (!beamRef.current) return;
      const { top, height, winH } = boundsRef.current;
      const progress = Math.min(1, Math.max(0, (scrollY + winH * 0.5 - top) / height));
      beamRef.current.style.transform = `scaleY(${progress})`;
    };

    const rafId = requestAnimationFrame(() => {
      measureBounds();
      updateBeam(window.scrollY || 0);
    });

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          measureBounds();
          updateBeam(window.scrollY || 0);
        })
      : null;
    if (ro && document.body) ro.observe(document.body);

    const unsub = subscribeScrollProgress(({ scrollY }) => updateBeam(scrollY));
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      unsub();
    };
  }, [containerRef]);

  return (
    <div
      ref={beamRef}
      style={{ transform: 'scaleY(0)' }}
      className="absolute left-8 sm:left-1/2 top-0 bottom-0 w-0.5 bg-linear-to-b from-cyan-400 via-indigo-500 to-emerald-400 origin-top transform sm:-translate-x-1/2 shadow-[0_0_12px_rgba(34,211,238,0.8)] z-0"
    />
  );
}

export default function ExperienceTimeline() {
  const { language, t } = useLanguage();
  const timelineData = useMemo(() => getTimelineData(language), [language]);
  const containerRef = useRef(null);
  const [beamActive, setBeamActive] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setBeamActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setBeamActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="timeline" ref={containerRef} className="relative px-4 sm:px-6 w-full max-w-4xl mx-auto pt-24 pb-24">
      <Reveal className="text-center space-y-4 mb-16">
        <div className="inline-flex items-center gap-2 rounded-full stitch-btn-glass px-3.5 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{t('timeline.badge')}</span>
        </div>
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-white">
          {t('timeline.title')}
        </h2>
        <p className="text-zinc-400 max-w-2xl mx-auto text-base sm:text-lg">
          {t('timeline.subtitle')}
        </p>
      </Reveal>

      <div className="relative pl-8 sm:pl-0">
        {/* Base Timeline Line (Gray) */}
        <div className="absolute left-8 sm:left-1/2 top-0 bottom-0 w-0.5 bg-white/10 transform sm:-translate-x-1/2" />

        {/* Scroll-Driven Light Beam Line (mounted only near viewport to avoid mount-time offsetParent reflow) */}
        {beamActive && <TimelineProgressBeam containerRef={containerRef} />}

        <div className="space-y-12">
          {timelineData.map((item, index) => {
            const isLeft = index % 2 === 0;
            const isEducation = item.type === 'education';

            return (
              <div
                key={index}
                className={`relative flex flex-col sm:flex-row items-start sm:items-center ${isLeft ? 'sm:justify-start' : 'sm:justify-end'} group`}
              >
                {/* Timeline Dot */}
                <div className="absolute left-0 sm:left-1/2 w-8 h-8 rounded-full border border-white/20 liquid-glass-inset liquid-glass-pill flex items-center justify-center transform -translate-x-1/2 sm:-translate-x-1/2 z-10 shadow-[0_0_15px_rgba(0,0,0,0.8)] group-hover:scale-125 transition-all duration-300">
                  <div className={`w-3 h-3 rounded-full ${isEducation ? 'bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,1)]' : 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,1)]'}`} />
                </div>

                {/* Content Card */}
                <div className={`w-full sm:w-[45%] pl-8 sm:pl-0 ${isLeft ? 'sm:pr-12 sm:text-right' : 'sm:pl-12 sm:text-left'}`}>
                  <Reveal
                    delay={(index % 2) * 0.08}
                    className="liquid-glass liquid-glass-hover p-6 sm:p-7 relative overflow-hidden text-left"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <span className="px-3 py-1 text-[10px] font-semibold tracking-wider text-cyan-300 stitch-btn-glass rounded-full uppercase">
                        {item.period}
                      </span>
                    </div>

                    <h3 className="text-lg sm:text-xl font-bold text-white mb-1 flex items-center gap-2">
                      {isEducation ? <GraduationCap className="w-5 h-5 text-indigo-400 shrink-0" /> : <Briefcase className="w-5 h-5 text-cyan-400 shrink-0" />}
                      <span>{item.title}</span>
                    </h3>
                    <p className="text-xs sm:text-sm font-medium text-cyan-400/90 mb-3">{item.institution}</p>
                    <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
                      {item.description}
                    </p>
                  </Reveal>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
