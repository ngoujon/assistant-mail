// Détection des réglages IMAP/SMTP depuis une adresse : fournisseurs connus,
// puis la base Mozilla (Thunderbird), puis les suppositions habituelles.
// Chaque piste est ensuite vérifiée par une vraie connexion.
const FOURNISSEURS = {
  'gmail.com': { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false }, note: "Gmail exige un mot de passe d'application (compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications)." },
  'googlemail.com': { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false }, note: "Gmail exige un mot de passe d'application." },
  'outlook.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'hotmail.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'hotmail.fr': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'live.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'yahoo.com': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, secure: false }, note: "Yahoo exige un mot de passe d'application." },
  'yahoo.fr': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, secure: false }, note: "Yahoo exige un mot de passe d'application." },
  'icloud.com': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, note: "iCloud exige un mot de passe pour application." },
  'me.com': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, note: "iCloud exige un mot de passe pour application." },
  'orange.fr': { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 587, secure: false } },
  'wanadoo.fr': { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 587, secure: false } },
  'free.fr': { imap: { host: 'imap.free.fr', port: 993, secure: true }, smtp: { host: 'smtp.free.fr', port: 587, secure: false } },
  'laposte.net': { imap: { host: 'imap.laposte.net', port: 993, secure: true }, smtp: { host: 'smtp.laposte.net', port: 587, secure: false } },
  'sfr.fr': { imap: { host: 'imap.sfr.fr', port: 993, secure: true }, smtp: { host: 'smtp.sfr.fr', port: 587, secure: false } },
  'gmx.com': { imap: { host: 'imap.gmx.com', port: 993, secure: true }, smtp: { host: 'mail.gmx.com', port: 587, secure: false } },
  'gmx.fr': { imap: { host: 'imap.gmx.com', port: 993, secure: true }, smtp: { host: 'mail.gmx.com', port: 587, secure: false } },
  'zoho.com': { imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 587, secure: false } },
  'ovh.net': { imap: { host: 'ssl0.ovh.net', port: 993, secure: true }, smtp: { host: 'ssl0.ovh.net', port: 587, secure: false } },
}

function parseAutoconfig(xml) {
  const bloc = (b) => {
    const host = b.match(/<hostname>(.*?)<\/hostname>/)?.[1]
    const port = Number(b.match(/<port>(.*?)<\/port>/)?.[1])
    const socket = b.match(/<socketType>(.*?)<\/socketType>/)?.[1]
    return host && port ? { host, port, secure: socket === 'SSL' } : null
  }
  const inc = xml.match(/<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/)?.[1]
  const out = xml.match(/<outgoingServer type="smtp">([\s\S]*?)<\/outgoingServer>/)?.[1]
  const imap = inc && bloc(inc)
  if (!imap) return null
  return { imap, smtp: out ? bloc(out) : null }
}

async function fromMozilla(domaine) {
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${domaine}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return parseAutoconfig(await res.text())
  } catch {
    return null
  }
}

export function providerNote(email) {
  const d = email.split('@')[1]?.toLowerCase().trim()
  return (d && FOURNISSEURS[d]?.note) || null
}

/** Liste ordonnée de configurations à essayer pour cette adresse. */
export async function guessCandidates(email) {
  const domaine = email.split('@')[1]?.toLowerCase().trim()
  if (!domaine) return []
  const out = []
  if (FOURNISSEURS[domaine]) out.push(FOURNISSEURS[domaine])
  const mozilla = await fromMozilla(domaine)
  if (mozilla) out.push(mozilla)
  out.push({ imap: { host: `imap.${domaine}`, port: 993, secure: true }, smtp: { host: `smtp.${domaine}`, port: 587, secure: false } })
  out.push({ imap: { host: `mail.${domaine}`, port: 993, secure: true }, smtp: { host: `mail.${domaine}`, port: 587, secure: false } })
  return out
}
