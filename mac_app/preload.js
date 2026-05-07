'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Wrap an ipcRenderer.on subscription; returns unsub function.
function on(ch, cb) {
  const handler = (_, data) => cb(data);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
}

contextBridge.exposeInMainWorld('electron', {
  // Invocations (renderer → main, returns Promise)
  startSession:   ()      => ipcRenderer.invoke('session:start'),
  resetSession:   ()      => ipcRenderer.invoke('session:reset'),
  openFilePicker: ()      => ipcRenderer.invoke('dialog:openFile'),
  sendFile:       (fpath) => ipcRenderer.invoke('file:send', fpath),

  // Subscriptions (main → renderer)
  onSessionNew:       (cb) => on('session:new',       cb),
  onWsStatus:         (cb) => on('ws:status',          cb),
  onWsMessage:        (cb) => on('ws:message',         cb),
  onWsError:          (cb) => on('ws:error',           cb),
  onTransferProgress: (cb) => on('transfer:progress',  cb),
  onTransferComplete: (cb) => on('transfer:complete',  cb),
  onTransferError:    (cb) => on('transfer:error',     cb),
  onReceiveProgress:  (cb) => on('receive:progress',   cb),
  onReceiveComplete:  (cb) => on('receive:complete',   cb),
  onReceiveError:     (cb) => on('receive:error',      cb),
});
