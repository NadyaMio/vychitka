const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  store: { get: () => ipcRenderer.invoke('store:get'), set: patch => ipcRenderer.invoke('store:set', patch) },
  engine: (method, ...args) => ipcRenderer.invoke('engine', method, args),
  openDialog: opts => ipcRenderer.invoke('file:open-dialog', opts),
  openPath: (file, remember) => ipcRenderer.invoke('file:open-path', file, remember),
  pathForFile: file => webUtils.getPathForFile(file),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.invoke('clipboard:write', text),
  save: req => ipcRenderer.invoke('file:save', req),
  saveReport: req => ipcRenderer.invoke('report:save', req),
  dictImport: () => ipcRenderer.invoke('dict:import'),
  dictExport: words => ipcRenderer.invoke('dict:export', words),
  dictSharedPick: () => ipcRenderer.invoke('dict:shared-pick'),
  openExternal: url => ipcRenderer.invoke('shell:open', url),
  reveal: file => ipcRenderer.invoke('shell:reveal', file),
  basesCheck: () => ipcRenderer.invoke('bases:check'),
  basesUpdate: () => ipcRenderer.invoke('bases:update'),
  appUpdateCheck: () => ipcRenderer.invoke('appupdate:check'),
  appUpdateInstall: () => ipcRenderer.invoke('appupdate:install'),
  closeConfirmed: () => ipcRenderer.invoke('app:close-confirmed'),
  onMenu: on('menu'),
  onOpenPath: on('open-path'),
  onBasesProgress: on('bases:progress'),
  onAppUpdate: on('appupdate:state'),
  onBeforeClose: on('app:before-close'),
});
