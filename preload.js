'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // renderer -> main (fire and forget)
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  // renderer -> main (await a reply)
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // main -> renderer
  on: (channel, fn) => {
    const wrapped = (_event, payload) => fn(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
