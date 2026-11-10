(function () {
  try {
    var isLegacyArchive = window.location.pathname.indexOf('/archive-v1') === 0;
    var saved = localStorage.getItem('portfolio-theme');
    var dark = isLegacyArchive ? saved !== 'light' : true;
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    if (window.location.hash) {
      window.__initialTargetHash = window.location.hash.replace('#', '');
      window.history.replaceState(null, '', window.location.href.split('#')[0]);
    }
  } catch {}
})();
