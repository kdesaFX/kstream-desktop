'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kstreamSetup', {
  getInfo: () => ipcRenderer.invoke('setup:getInfo'),
  install: () => ipcRenderer.invoke('setup:install'),
  portable: () => ipcRenderer.invoke('setup:portable'),
});
