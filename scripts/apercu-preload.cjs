// Preload factice : sert uniquement à prévisualiser l'interface (scripts/apercu.mjs).
const { contextBridge } = require('electron')

let listener = () => {}

const COMPTES = [
  { id: 'c1', nom: 'Perso', email: 'nicolas@exemple.fr', imap: { host: 'imap.exemple.fr', port: 993, secure: true, user: 'nicolas@exemple.fr' }, smtp: { host: 'smtp.exemple.fr', port: 587, secure: false, user: 'nicolas@exemple.fr' }, etat: 'ok' },
  { id: 'c2', nom: 'Pro', email: 'contact@societe.fr', imap: { host: 'ssl0.ovh.net', port: 993, secure: true, user: 'contact@societe.fr' }, smtp: { host: 'ssl0.ovh.net', port: 587, secure: false, user: 'contact@societe.fr' }, etat: 'ok' },
]

contextBridge.exposeInMainWorld('mailzen', {
  init: async () => ({ config: { model: 'claude-opus-5', seuilConfirmation: 50 }, workspace: '/tmp', comptes: COMPTES, version: '2.0.0' }),
  send: () => {},
  interrupt: () => {},
  newChat: () => {},
  setConfig: () => {},
  replyPermission: () => {},
  comptes: { list: async () => COMPTES, detect: async () => ({ ok: false }), test: async () => ({}), save: async () => ({ ok: true }), remove: async () => COMPTES },
  traitements: async () => [],
  arreterTraitement: async () => ({ arrete: true }),
  openWorkspace: () => {},
  openData: () => {},
  openExternal: () => {},
  onEvent: (cb) => { listener = cb; return () => {} },
  _fire: (evt) => listener(evt),
})
