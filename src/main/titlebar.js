'use strict';

/** Injected into the remote web app so the frameless window always has chrome. */
const TITLEBAR_CSS = `
html.is-desktop-app {
  --desktop-titlebar-height: 36px;
}
html.is-desktop-app #root {
  padding-top: var(--desktop-titlebar-height) !important;
  box-sizing: border-box;
}
html.is-desktop-app .top-content {
  top: var(--desktop-titlebar-height) !important;
}
html.is-desktop-app .kstream-desktop-banner {
  top: var(--desktop-titlebar-height) !important;
}
#kstream-native-titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  z-index: 2147483646;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  background: #141414;
  color: #d4d4d4;
  font: 500 13px/1 system-ui, Segoe UI, sans-serif;
  -webkit-app-region: drag;
  app-region: drag;
  user-select: none;
}
#kstream-native-titlebar .brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
#kstream-native-titlebar .brand svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
#kstream-native-titlebar .controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
#kstream-native-titlebar button {
  width: 46px;
  height: 100%;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  color: #c8c8c8;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
#kstream-native-titlebar button:hover {
  background: rgba(255,255,255,0.08);
  color: #fff;
}
#kstream-native-titlebar button.close:hover {
  background: #e81123;
  color: #fff;
}
`;

const TITLEBAR_JS = `
(() => {
  if (document.getElementById('kstream-native-titlebar')) return;
  document.documentElement.classList.add('is-desktop-app');
  window.__KSTREAM_NATIVE_TITLEBAR__ = true;

  const bar = document.createElement('div');
  bar.id = 'kstream-native-titlebar';
  bar.setAttribute('role', 'banner');
  bar.innerHTML = \`
    <div class="brand">
      <svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="64" cy="64" r="18" fill="#6eecd9"></circle>
        <path d="M38 44c-10 8-10 32 0 40" stroke="#6eecd9" stroke-width="10" stroke-linecap="round"></path>
        <path d="M90 44c10 8 10 32 0 40" stroke="#6eecd9" stroke-width="10" stroke-linecap="round"></path>
        <path d="M24 32c-16 14-16 50 0 64" stroke="#6eecd9" stroke-width="10" stroke-linecap="round"></path>
        <path d="M104 32c16 14 16 50 0 64" stroke="#6eecd9" stroke-width="10" stroke-linecap="round"></path>
      </svg>
      <span>kstream</span>
    </div>
    <div class="controls">
      <button type="button" data-action="minimize" title="Minimize" aria-label="Minimize">
        <svg viewBox="0 0 12 12" width="10" height="10"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"></rect></svg>
      </button>
      <button type="button" data-action="maximize" title="Maximize" aria-label="Maximize">
        <svg viewBox="0 0 12 12" width="10" height="10"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"></rect></svg>
      </button>
      <button type="button" data-action="close" class="close" title="Close" aria-label="Close">
        <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.2 2.2l7.6 7.6M9.8 2.2L2.2 9.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>
      </button>
    </div>
  \`;

  const mount = () => {
    if (!document.body) return;
    if (!document.getElementById('kstream-native-titlebar')) {
      document.body.prepend(bar);
    }
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  bar.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn || !window.desktopApi || !window.desktopApi.windowControls) return;
    const action = btn.getAttribute('data-action');
    if (action === 'minimize') window.desktopApi.windowControls.minimize();
    if (action === 'maximize') window.desktopApi.windowControls.maximize();
    if (action === 'close') window.desktopApi.windowControls.close();
  });
})();
`;

async function installNativeTitleBar(win) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.insertCSS(TITLEBAR_CSS);
  } catch (err) {
    console.warn('[kstream-desktop] titlebar css failed', err);
  }
  try {
    await win.webContents.executeJavaScript(TITLEBAR_JS, true);
  } catch (err) {
    console.warn('[kstream-desktop] titlebar js failed', err);
  }
}

module.exports = {
  installNativeTitleBar,
};
