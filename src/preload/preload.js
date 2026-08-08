const { contextBridge, ipcRenderer } = require('electron');

const PUBLIC_CHANNELS = [
  'hello',
  'makeRequest',
  'prepareStream',
  'openPage',
  'updateMediaMetadata',
  'openOfflineApp',
];

// Plasmo messaging relay: web app posts { name, body, relayId } → main IPC → post response
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || !data.name || data.relayed) return;
  if (!PUBLIC_CHANNELS.includes(data.name)) return;

  try {
    const response = await ipcRenderer.invoke(data.name, data.body);
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

// Core v1 stubs — offline downloads come later
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

console.log('[kstream-desktop] preload ready');
