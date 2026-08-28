// Les comptes IMAP/SMTP : le seul état de l'ancienne application qu'on garde.
// Stockage : un JSON dans le dossier de données, mots de passe chiffrés.
import fs from 'node:fs'
import { P } from './paths.mjs'
import { encrypt, decrypt } from './crypto.mjs'

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(P.accounts(), 'utf8'))
    return Array.isArray(raw?.comptes) ? raw.comptes : []
  } catch {
    return []
  }
}

function write(list) {
  fs.writeFileSync(P.accounts(), JSON.stringify({ comptes: list }, null, 2), { mode: 0o600 })
}

export function listAccounts() {
  return read()
}

/** Vue publique : jamais de mot de passe, même chiffré. */
export function publicAccounts() {
  return read().map((a) => ({
    id: a.id,
    nom: a.nom,
    email: a.email,
    couleur: a.couleur,
    imap: { host: a.imap.host, port: a.imap.port, secure: a.imap.secure, user: a.imap.user },
    smtp: a.smtp?.host ? { host: a.smtp.host, port: a.smtp.port, secure: a.smtp.secure, user: a.smtp.user } : null,
    certificatNonVerifie: !!a.certificatNonVerifie,
    etat: a.etat || 'inconnu',
    derniereErreur: a.derniereErreur || null,
  }))
}

/**
 * Retrouve un compte à partir de ce que l'assistant a sous la main :
 * un identifiant, une adresse, ou un bout de nom (« perso », « pro »).
 */
export function resolveAccount(ref) {
  const list = read()
  if (!list.length) throw new Error("Aucune boîte mail n'est configurée. Ajoute-la dans les réglages (⚙) de l'application.")
  if (ref == null || ref === '') {
    if (list.length === 1) return list[0]
    throw new Error(`Précise la boîte mail : ${list.map((a) => a.nom).join(', ')}.`)
  }
  const needle = String(ref).trim().toLowerCase()
  const exact = list.find((a) => String(a.id) === needle || a.email.toLowerCase() === needle || a.nom.toLowerCase() === needle)
  if (exact) return exact
  const partial = list.filter((a) => a.nom.toLowerCase().includes(needle) || a.email.toLowerCase().includes(needle))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) throw new Error(`« ${ref} » désigne plusieurs boîtes : ${partial.map((a) => a.nom).join(', ')}.`)
  throw new Error(`Boîte mail « ${ref} » inconnue. Boîtes configurées : ${list.map((a) => a.nom).join(', ')}.`)
}

export function accountPassword(acc, which = 'imap') {
  if (which === 'smtp') return decrypt(acc.smtp?.pass || acc.imap.pass)
  return decrypt(acc.imap.pass)
}

export function saveAccount(input) {
  const list = read()
  const id = input.id || `c${Date.now().toString(36)}`
  const existing = list.find((a) => a.id === id)
  const acc = {
    id,
    nom: input.nom?.trim() || input.email,
    email: input.email.trim(),
    couleur: input.couleur || existing?.couleur || '#5b8def',
    imap: {
      host: input.imap.host.trim(),
      port: Number(input.imap.port) || 993,
      secure: input.imap.secure !== false,
      user: (input.imap.user || input.email).trim(),
      pass: input.imap.pass ? encrypt(input.imap.pass) : existing?.imap?.pass || '',
    },
    smtp: input.smtp?.host
      ? {
          host: input.smtp.host.trim(),
          port: Number(input.smtp.port) || 587,
          secure: !!input.smtp.secure,
          user: (input.smtp.user || input.imap.user || input.email).trim(),
          pass: input.smtp.pass ? encrypt(input.smtp.pass) : existing?.smtp?.pass || '',
        }
      : null,
    certificatNonVerifie: !!input.certificatNonVerifie,
    etat: input.etat || existing?.etat || 'inconnu',
    derniereErreur: input.derniereErreur ?? existing?.derniereErreur ?? null,
    creeLe: existing?.creeLe || new Date().toISOString(),
  }
  const next = existing ? list.map((a) => (a.id === id ? acc : a)) : [...list, acc]
  write(next)
  return acc
}

export function markAccount(id, patch) {
  const list = read()
  const next = list.map((a) => (a.id === id ? { ...a, ...patch } : a))
  write(next)
}

export function deleteAccount(id) {
  write(read().filter((a) => a.id !== id))
}
