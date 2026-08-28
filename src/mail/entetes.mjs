// Analyse d'un bloc d'en-têtes brut renvoyé par IMAP (dépliage des lignes,
// décodage MIME sommaire). On ne charge pas mailparser pour trois en-têtes.
export function parseHeaders(buffer) {
  const map = new Map()
  if (!buffer) return map
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) { current = null; continue }
    if (/^[ \t]/.test(raw) && current) {
      current.value += ' ' + raw.trim()
      continue
    }
    const i = raw.indexOf(':')
    if (i < 0) continue
    const name = raw.slice(0, i).trim().toLowerCase()
    current = { value: raw.slice(i + 1).trim() }
    if (!map.has(name)) map.set(name, [])
    map.get(name).push(current)
  }
  const out = new Map()
  for (const [name, entries] of map) out.set(name, entries.map((e) => decodeWords(e.value)))
  return out
}

export function header(headers, name) {
  return headers.get(name)?.[0] || null
}

/** Décode les mots encodés RFC 2047 (« =?UTF-8?B?...?= ») des sujets et noms. */
export function decodeWords(value) {
  if (!value || !value.includes('=?')) return value
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, enc, data) => {
    try {
      const bytes = enc.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary')
      return new TextDecoder(charset.toLowerCase().replace(/^utf8$/, 'utf-8')).decode(bytes)
    } catch {
      return whole
    }
  }).replace(/\?=\s+=\?/g, '?==?')
}
