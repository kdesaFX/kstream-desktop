const { contextBridge, ipcRenderer } = require('electron');

const PUBLIC_CHANNELS = [
  'hello',
  'makeRequest',
  'prepareStream',
  'openPage',
  'updateMediaMetadata',
  'openOfflineApp',
];

async function invokeDesktop(name, body) {
  if (!PUBLIC_CHANNELS.includes(name)) {
    throw new Error(`Blocked desktop channel: ${name}`);
  }
  return ipcRenderer.invoke(name, body);
}

// Direct IPC for the web app (preferred). Plasmo postMessage relay is fragile in Electron.
contextBridge.exposeInMainWorld('__KSTREAM_DESKTOP_IPC__', {
  invoke: (name, body) => invokeDesktop(name, body),
});

// Plasmo messaging relay fallback: web posts { name, body, relayId, instanceId }
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || !data.name || data.relayed) return;
  if (!PUBLIC_CHANNELS.includes(data.name)) return;

  try {
    const response = await invokeDesktop(data.name, data.body);
    if (data.name !== 'updateMediaMetadata') {
      window.postMessage(
        {
          name: data.name,
          relayId: data.relayId,
          instanceId: data.instanceId,
          body: response,
          relayed: true,
        },
        '*',
      );
    }
  } catch (error) {
    console.error(`[kstream-desktop] Error handling ${data.name}:`, error);
    if (data.name !== 'updateMediaMetadata') {
      window.postMessage(
        {
          name: data.name,
          relayId: data.relayId,
          instanceId: data.instanceId,
          body: { success: false, error: error.message },
          relayed: true,
        },
        '*',
      );
    }
  }
});

contextBridge.exposeInMainWorld('__PSTREAM_DESKTOP__', true);
contextBridge.exposeInMainWorld('isDesktopApp', true);
contextBridge.exposeInMainWorld('PSTREAM_DESKTOP', true);

contextBridge.exposeInMainWorld('desktopApi', {
  startDownload() {
    console.info('[kstream-desktop] Offline downloads are not available in Core v1.');
  },
  openOffline() {
    console.info('[kstream-desktop] Offline library is not available in Core v1.');
  },
});

contextBridge.exposeInMainWorld('__PSTREAM_OPEN_SETTINGS__', () => {
  ipcRenderer.send('open-settings');
});

window.addEventListener('pstream-desktop-settings', () => {
  ipcRenderer.send('open-settings');
});

console.log('[kstream-desktop] preload ready (direct IPC + relay)');
