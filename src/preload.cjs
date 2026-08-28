const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mailzen', {
  init: () => ipcRenderer.invoke('app:init'),
  send: (text) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  newChat: () => ipcRenderer.send('chat:new'),
  setConfig: (patch) => ipcRenderer.send('chat:config', patch),
  replyPermission: (id, answer) => ipcRenderer.send('perm:reply', { id, answer }),

  comptes: {
    list: () => ipcRenderer.invoke('comptes:list'),
    detect: (args) => ipcRenderer.invoke('comptes:detect', args),
    test: (cfg) => ipcRenderer.invoke('comptes:test', cfg),
    save: (cfg) => ipcRenderer.invoke('comptes:save', cfg),
    remove: (id) => ipcRenderer.invoke('comptes:delete', id),
  },
  traitements: () => ipcRenderer.invoke('traitements:list'),
  arreterTraitement: (id) => ipcRenderer.invoke('traitements:arreter', id),

  openWorkspace: () => ipcRenderer.send('app:open-workspace'),
  openData: () => ipcRenderer.send('app:open-data'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),

  onEvent: (cb) => {
    const handler = (_e, evt) => cb(evt)
    ipcRenderer.on('agent', handler)
    return () => ipcRenderer.removeListener('agent', handler)
  },
})
