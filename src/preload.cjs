const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assistantMail', {
  init: () => ipcRenderer.invoke('app:init'),
  send: (tab, text) => ipcRenderer.send('chat:send', { tab, text }),
  interrupt: (tab) => ipcRenderer.send('chat:interrupt', tab),
  setConfig: (patch) => ipcRenderer.send('chat:config', patch),
  replyPermission: (id, answer) => ipcRenderer.send('perm:reply', { id, answer }),

  onglets: {
    nouveau: () => ipcRenderer.invoke('onglets:nouveau'),
    activer: (id) => ipcRenderer.send('onglets:activer', id),
    fermer: (id) => ipcRenderer.send('onglets:fermer', id),
    fil: (id) => ipcRenderer.invoke('onglets:fil', id),
  },
  conversations: {
    liste: () => ipcRenderer.invoke('conversations:liste'),
    ouvrir: (c) => ipcRenderer.invoke('conversations:ouvrir', c),
  },

  comptes: {
    list: () => ipcRenderer.invoke('comptes:list'),
    detect: (args) => ipcRenderer.invoke('comptes:detect', args),
    test: (cfg) => ipcRenderer.invoke('comptes:test', cfg),
    save: (cfg) => ipcRenderer.invoke('comptes:save', cfg),
    changePassword: (id, pass) => ipcRenderer.invoke('comptes:password', { id, pass }),
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
