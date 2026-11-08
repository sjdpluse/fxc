export function createInstaller({ win = window, nav = navigator, onChange = () => {} } = {}) {
  let deferred = null;
  let installing = false;
  let message = '';
  const displayMode = win.matchMedia('(display-mode: standalone)');
  let installed = displayMode.matches || nav.standalone === true;
  const state = () => ({ installed, available: !!deferred, installing, message });
  const publish = () => onChange(state());

  win.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); deferred = event; message = ''; publish();
  });
  win.addEventListener('appinstalled', () => {
    installed = true; deferred = null; installing = false; message = 'FXC has been installed. Open it from your home screen.'; publish();
  });
  displayMode.addEventListener?.('change', (event) => { installed = event.matches || nav.standalone === true; publish(); });

  return {
    state,
    async install() {
      if (installed) return { outcome: 'installed' };
      if (installing) return { outcome: 'busy' };
      if (!deferred) { message = 'Open FXC in Chrome on Android. Tap the browser menu, then Install app or Add to Home screen.'; publish(); return { outcome: 'help' }; }
      const event = deferred;
      deferred = null; installing = true; message = ''; publish();
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        message = installed ? 'FXC has been installed. Open it from your home screen.' : outcome === 'accepted' ? 'Installation requested. Check your home screen when it finishes.' : 'Installation canceled. You can install later from your browser menu.';
        return { outcome };
      } catch {
        message = 'Use Chrome’s menu to install FXC or add it to your home screen.';
        return { outcome: 'help' };
      } finally { installing = false; publish(); }
    },
    async register() {
      if (!win.isSecureContext || !('serviceWorker' in nav)) return false;
      try {
        await nav.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname, updateViaCache: 'none' });
        return true;
      } catch { return false; } // Installation help and the online journal remain usable.
    }
  };
}
