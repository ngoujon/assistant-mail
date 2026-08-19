/**
 * Détection automatique des paramètres IMAP/SMTP à partir d'une adresse e-mail :
 * base de fournisseurs connus, puis config Mozilla ISPDB (Thunderbird), puis
 * suppositions génériques (imap./smtp.{domaine}). Chaque piste est ensuite
 * vérifiée par une vraie connexion (voir testImapRaw/testSmtpRaw dans imap.js).
 */
const KNOWN_PROVIDERS = {
  'gmail.com': { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false } },
  'googlemail.com': { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false } },
  'outlook.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'hotmail.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'hotmail.fr': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'live.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  'yahoo.com': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, secure: false } },
  'yahoo.fr': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, secure: false } },
  'icloud.com': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  'me.com': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  'orange.fr': { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 587, secure: false } },
  'wanadoo.fr': { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 587, secure: false } },
  'free.fr': { imap: { host: 'imap.free.fr', port: 993, secure: true }, smtp: { host: 'smtp.free.fr', port: 587, secure: false } },
  'laposte.net': { imap: { host: 'imap.laposte.net', port: 993, secure: true }, smtp: { host: 'smtp.laposte.net', port: 587, secure: false } },
  'sfr.fr': { imap: { host: 'imap.sfr.fr', port: 993, secure: true }, smtp: { host: 'smtp.sfr.fr', port: 587, secure: false } },
  'gmx.com': { imap: { host: 'imap.gmx.com', port: 993, secure: true }, smtp: { host: 'mail.gmx.com', port: 587, secure: false } },
  'gmx.fr': { imap: { host: 'imap.gmx.com', port: 993, secure: true }, smtp: { host: 'mail.gmx.com', port: 587, secure: false } },
  'zoho.com': { imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 587, secure: false } }
};

function parseAutoconfigXml(xml) {
  const parseBlock = (tag, block) => {
    const hostname = block.match(/<hostname>(.*?)<\/hostname>/)?.[1];
    const port = Number(block.match(/<port>(.*?)<\/port>/)?.[1]);
    const socketType = block.match(/<socketType>(.*?)<\/socketType>/)?.[1];
    return hostname && port ? { host: hostname, port, secure: socketType === 'SSL' } : null;
  };
  const imapBlock = xml.match(/<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/)?.[1];
  const smtpBlock = xml.match(/<outgoingServer type="smtp">([\s\S]*?)<\/outgoingServer>/)?.[1];
  const imap = imapBlock && parseBlock('imap', imapBlock);
  if (!imap) return null;
  return { imap, smtp: smtpBlock ? parseBlock('smtp', smtpBlock) : null };
}

async function fetchAutoconfig(domain) {
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${domain}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return parseAutoconfigXml(await res.text());
  } catch {
    return null;
  }
}

/** Retourne une liste ordonnée de configurations candidates à essayer. */
export async function guessCandidates(email) {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return [];
  const candidates = [];
  if (KNOWN_PROVIDERS[domain]) candidates.push(KNOWN_PROVIDERS[domain]);
  const autoconfig = await fetchAutoconfig(domain);
  if (autoconfig) candidates.push(autoconfig);
  candidates.push({ imap: { host: `imap.${domain}`, port: 993, secure: true }, smtp: { host: `smtp.${domain}`, port: 587, secure: false } });
  candidates.push({ imap: { host: `mail.${domain}`, port: 993, secure: true }, smtp: { host: `mail.${domain}`, port: 587, secure: false } });
  return candidates;
}
