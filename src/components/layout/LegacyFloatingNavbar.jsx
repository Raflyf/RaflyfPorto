import React, { useEffect, useState, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Shield, Menu, X, Sun, Moon, Globe } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { telemetry } from '../../lib/telemetry';
import { smoothScrollTo } from '../../lib/smooth-scroll.js';

export default function LegacyFloatingNavbar() {
  const { language, toggleLanguage, t } = useLanguage();
  const [scrolled, setScrolled] = useState(false);
  const [navVisible, setNavVisible] = useState(true);
  const lastScrollY = useRef(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return true;
    return document.documentElement.classList.contains('dark');
  });
  const location = useLocation();

  useEffect(() => {
    const applyTheme = (dark) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      localStorage.setItem('portfolio-theme', dark ? 'dark' : 'light');
      setIsDark(dark);
    };

    const saved = localStorage.getItem('portfolio-theme');
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved === 'dark');
    }
  }, [location.pathname]);

  const handleThemeToggle = () => {
    const nextDark = !isDark;
    document.documentElement.classList.toggle('dark', nextDark);
    localStorage.setItem('portfolio-theme', nextDark ? 'dark' : 'light');
    setIsDark(nextDark);
    telemetry.logEvent('theme_toggle', 'mode_switch', `Ubah Mode Tema Tampilan ke ${nextDark ? 'gelap' : 'terang'}`);
  };

  useEffect(() => {
    const threshold = 10;
    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentY = window.scrollY;
          const delta = currentY - lastScrollY.current;

          if (currentY < 70) {
            setNavVisible(true);
          } else if (Math.abs(delta) > threshold) {
            if (delta > 0) {
              if (!mobileMenuOpen) {
                setNavVisible(false);
              }
            } else {
              setNavVisible(true);
            }
            lastScrollY.current = currentY;
          }

          setScrolled(currentY > 20);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen]);

  const handleBrandClick = (e) => {
    if (location.pathname === '/') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleNavClick = (e, href) => {
    if (href.startsWith('/#')) {
      e.preventDefault();
      const id = href.replace('/#', '');
      const el = document.getElementById(id);
      if (el) {
        smoothScrollTo(el, { duration: 1.2, offset: -40 });
      }
    }
  };

  const navLinks = [
    { name: t('nav.about'), href: '/#about' },
    { name: t('nav.skills'), href: '/#skills' },
    { name: t('nav.projects'), href: '/#projects' },
    { name: t('nav.certificates'), href: '/#certificates' },
    { name: t('nav.timeline'), href: '/#timeline' },
    { name: t('nav.lab'), href: '/#lab' },
    { name: t('nav.contact'), href: '/#contact' },
  ];

  return (
    <header className={`fixed top-0 inset-x-0 z-50 pointer-events-none transition-transform duration-300 ease-in-out ${
      navVisible ? 'translate-y-0' : '-translate-y-full'
    }`}>
      <div className={`w-full pointer-events-auto px-6 lg:px-8 py-3.5 flex items-center justify-between transition-all duration-300 ${
        scrolled || mobileMenuOpen
          ? 'liquid-glass-nav'
          : 'bg-transparent border-b border-transparent'
      }`}>
        <Link to="/" onClick={handleBrandClick} className="flex items-center gap-3 group cursor-pointer" title={t('nav.returnTopTitle')}>
          <div className="w-9 h-9 rounded-full bg-linear-to-tr from-cyan-500/30 to-indigo-500/30 border border-cyan-400/50 flex items-center justify-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)] group-hover:scale-105 transition-transform">
            <span className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">RF</span>
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold text-zinc-900 dark:text-white tracking-tight leading-snug group-hover:text-cyan-600 dark:group-hover:text-cyan-300 transition-colors">
              Rafly Firmansyah
            </span>
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 leading-none flex items-center gap-1.5 mt-0.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]" />
              {t('nav.onlineStatus')}
            </span>
          </div>
        </Link>

        <nav className="hidden md:flex items-center gap-1.5">
          {navLinks.map((link) => (
            <a
              key={link.name}
              href={link.href}
              onClick={(e) => {
                handleNavClick(e, link.href);
                telemetry.logEvent('nav_click', link.href, `Navigasi Menu: ${link.name}`);
              }}
              className="px-4 py-2 rounded-full text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/10 liquid-press transition-all"
            >
              {link.name}
            </a>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-2.5">
          <button
            onClick={toggleLanguage}
            className="px-3 py-1.5 rounded-full liquid-glass-inset liquid-glass-pill liquid-press text-xs font-mono font-bold text-zinc-700 dark:text-zinc-200 hover:text-zinc-950 dark:hover:text-white cursor-pointer transition-all flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            aria-label={t('nav.switchLanguage')}
            title={language === 'id' ? 'Switch language to English' : 'Ganti bahasa ke Bahasa Indonesia'}
          >
            <Globe className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
            <span className={language === 'id' ? 'text-cyan-600 dark:text-cyan-300 font-extrabold' : 'opacity-60'}>ID</span>
            <span className="opacity-30">/</span>
            <span className={language === 'en' ? 'text-cyan-600 dark:text-cyan-300 font-extrabold' : 'opacity-60'}>EN</span>
          </button>

          <button
            onClick={handleThemeToggle}
            className="w-9 h-9 rounded-full liquid-glass-inset liquid-glass-pill liquid-press flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:text-zinc-950 dark:hover:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            aria-label={t('nav.themeToggle')}
            title={`${t('nav.themeToggle')} (${isDark ? t('nav.lightMode') : t('nav.darkMode')})`}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-200 liquid-press transition-all shadow-[0_0_15px_rgba(16,185,129,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <Shield className="w-4 h-4" />
            <span>{t('nav.dashboard')}</span>
          </Link>
        </div>

        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden w-9 h-9 rounded-full liquid-glass-inset liquid-glass-pill liquid-press flex items-center justify-center text-zinc-800 dark:text-zinc-200 hover:text-zinc-950 dark:hover:text-white cursor-pointer"
          aria-label="Menu Navigasi"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileMenuOpen && (
        <>
          <div 
            onClick={() => setMobileMenuOpen(false)}
            className="fixed inset-0 bg-black/35 dark:bg-black/50 backdrop-blur-sm z-[-1] pointer-events-auto transition-opacity"
            aria-hidden="true"
          />

          <nav 
            role="dialog"
            aria-modal="true"
            className="md:hidden mx-4 mt-2 p-3.5 liquid-glass-strong glass-spring-in flex flex-col gap-1.5 pointer-events-auto"
            aria-label="Menu Mobile"
          >
            {navLinks.map((link) => (
              <button
                key={link.name}
                onClick={(e) => {
                  handleNavClick(e, link.href);
                  telemetry.logEvent('nav_click', link.href, `Navigasi Menu: ${link.name}`);
                  setMobileMenuOpen(false);
                }}
                className="w-full px-4 py-3 rounded-xl text-sm font-semibold text-zinc-800 dark:text-zinc-100 hover:text-zinc-950 dark:hover:text-white hover:bg-white/25 dark:hover:bg-white/10 active:bg-white/35 dark:active:bg-white/15 liquid-press transition-all text-left flex items-center justify-between cursor-pointer"
              >
                <span>{link.name}</span>
                <span className="text-zinc-400 dark:text-zinc-400 text-xs">→</span>
              </button>
            ))}

            <div className="h-px bg-zinc-300/40 dark:bg-white/10 my-1 mx-2" />

            <button
              onClick={() => {
                toggleLanguage();
                setMobileMenuOpen(false);
              }}
              className="flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold liquid-glass-inset text-zinc-800 dark:text-zinc-200 hover:bg-white/30 dark:hover:bg-white/10 active:bg-white/40 dark:active:bg-white/15 liquid-press transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Globe className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                <span>{t('nav.switchLanguage')}</span>
              </div>
              <span className="text-xs font-mono font-bold text-cyan-600 dark:text-cyan-300">
                {language === 'id' ? 'Bahasa Indonesia (ID)' : 'English (EN)'}
              </span>
            </button>

            <button
              onClick={() => {
                handleThemeToggle();
                setMobileMenuOpen(false);
              }}
              className="flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold liquid-glass-inset text-zinc-800 dark:text-zinc-200 hover:bg-white/30 dark:hover:bg-white/10 active:bg-white/40 dark:active:bg-white/15 liquid-press transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                {isDark ? <Sun className="w-4 h-4 text-amber-500 dark:text-cyan-400" /> : <Moon className="w-4 h-4 text-indigo-600 dark:text-cyan-400" />}
                <span>{t('nav.themeToggle')}</span>
              </div>
              <span className="text-xs font-mono font-medium text-zinc-600 dark:text-zinc-400">
                {isDark ? t('nav.darkMode') : t('nav.lightMode')}
              </span>
            </button>

            <Link
              to="/dashboard"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold bg-emerald-500/20 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 dark:border-emerald-500/40 liquid-press transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{t('nav.dashboardFull')}</span>
              </div>
              <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-bold">LIVE</span>
            </Link>
          </nav>
        </>
      )}
    </header>
  );
}
