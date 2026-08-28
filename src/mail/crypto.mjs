// Chiffrement des mots de passe IMAP/SMTP (AES-256-GCM).
// La clé vit dans un fichier du dossier de données, en 0600 : elle ne transite
// jamais par la conversation avec l'assistant, qui ne voit que des identifiants.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { P } from './paths.mjs'

let cached = null

function key() {
  if (cached) return cached
  const file = P.key()
  try {
    const raw = fs.readFileSync(file)
    if (raw.length >= 32) { cached = raw.subarray(0, 32); return cached }
  } catch {}
  cached = crypto.randomBytes(32)
  fs.writeFileSync(file, cached, { mode: 0o600 })
  return cached
}

export function encrypt(plain) {
  if (plain == null || plain === '') return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

export function decrypt(payload) {
  if (!payload) return ''
  const [version, iv, tag, data] = String(payload).split(':')
  if (version !== 'v1') return ''
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new Error('Mot de passe illisible : la clé de chiffrement a changé, ressaisis le compte.')
  }
}
