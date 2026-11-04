// Importe dans l'assistant les boîtes configurées dans Apple Mail qui n'y sont pas encore.
// Apple Mail ne laisse pas lire ses mots de passe : une fenêtre macOS les demande,
// un par boîte. Chaque boîte est testée (IMAP puis SMTP) avant d'être enregistrée.
// Usage : node scripts/importer-apple-mail.mjs   (relancer l'app ensuite)
import { execFileSync } from 'node:child_process'
import { listAccounts, saveAccount } from '../src/mail/accounts.mjs'
import { testImapRaw, testSmtpRaw } from '../src/mail/imap.mjs'

const SEP = '\u001f'

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
}

function comptesAppleMail() {
  const brut = osa(`
set out to ""
tell application "Mail"
  repeat with a in every account
    if enabled of a then
      set em to ""
      try
        set em to (item 1 of (get email addresses of a))
      end try
      set s to "${SEP}${SEP}"
      try
        set sm to smtp server of a
        set s to (server name of sm) & "${SEP}" & (port of sm) & "${SEP}" & (user name of sm)
      end try
      set out to out & (name of a) & "${SEP}" & em & "${SEP}" & (user name of a) & "${SEP}" & (server name of a) & "${SEP}" & (port of a) & "${SEP}" & s & linefeed
    end if
  end repeat
end tell
return out`)
  return brut.split('\n').filter(Boolean).map((ligne) => {
    const [nom, email, user, imapHost, imapPort, smtpHost, smtpPort, smtpUser] = ligne.split(SEP)
    return { nom, email, user, imapHost, imapPort: Number(imapPort), smtpHost, smtpPort: Number(smtpPort), smtpUser }
  })
}

/** Les réglages à essayer : Apple Mail note parfois 143 + SSL, on passe alors en 993 chiffré. */
function reglages(c) {
  const icloud = /mail\.me\.com$/.test(c.imapHost)
  // iCloud : Apple Mail se connecte par jeton avec l'identifiant Apple ; en IMAP, c'est l'adresse iCloud.
  const user = icloud ? c.email : c.user || c.email
  const imap = { host: c.imapHost, port: c.imapPort === 143 ? 993 : c.imapPort || 993, secure: true, user }
  const smtp = c.smtpHost
    ? { host: c.smtpHost, port: c.smtpPort || 587, secure: c.smtpPort === 465, user: icloud ? c.email : c.smtpUser || user }
    : null
  return { imap, smtp, icloud }
}

function demanderMotDePasse(c, icloud, erreur) {
  const aide = icloud ? "\\n\\niCloud exige un mot de passe pour app (appleid.apple.com → Connexion et sécurité)." : ''
  const err = erreur ? `\\n\\n⚠️ ${erreur.replace(/["\\]/g, ' ').slice(0, 200)}` : ''
  try {
    return osa(`text returned of (display dialog "Mot de passe de la boîte ${c.email} (${c.nom})${aide}${err}" default answer "" with hidden answer with title "Assistant Mail — import Apple Mail" buttons {"Ignorer", "OK"} default button "OK" cancel button "Ignorer")`)
  } catch {
    return null // « Ignorer »
  }
}

const deja = new Set(listAccounts().map((a) => a.email.toLowerCase()))
const nouvelles = comptesAppleMail().filter((c) => c.email && !deja.has(c.email.toLowerCase()))

if (!nouvelles.length) {
  console.log('Rien à importer : toutes les boîtes d\u2019Apple Mail sont déjà dans l\u2019assistant.')
  process.exit(0)
}
console.log(`${nouvelles.length} boîte(s) à importer : ${nouvelles.map((c) => c.email).join(', ')}\n`)
if (process.argv.includes('--liste')) {
  for (const c of nouvelles) console.log(c.email, JSON.stringify(reglages(c)))
  process.exit(0)
}

const bilan = { ok: [], ignorees: [] }
for (const c of nouvelles) {
  const { imap, smtp, icloud } = reglages(c)
  let erreur = null
  let fait = false
  for (let essai = 0; essai < 3 && !fait; essai++) {
    const pass = demanderMotDePasse(c, icloud, erreur)
    if (pass == null || pass === '') break
    try {
      await testImapRaw({ ...imap, pass })
    } catch (err) {
      erreur = `Connexion refusée : ${err.message}`
      console.log(`✗ ${c.email} — ${erreur}`)
      continue
    }
    let smtpOk = null
    if (smtp) {
      for (const v of [smtp, { ...smtp, port: 465, secure: true }, { ...smtp, port: 587, secure: false }]) {
        try { await testSmtpRaw({ ...v, pass }); smtpOk = v; break } catch {}
      }
    }
    saveAccount({
      nom: c.nom.includes('@') ? c.email.split('@')[0].toUpperCase() + ' ' + c.email.split('@')[1].split('.')[0].toUpperCase() : c.nom.toUpperCase(),
      email: c.email,
      imap: { ...imap, pass },
      smtp: smtpOk ? { ...smtpOk, pass } : null,
      etat: 'ok',
      derniereErreur: null,
    })
    console.log(`✓ ${c.email}${smtpOk ? '' : ' (IMAP seulement : aucun SMTP ne répond)'}`)
    bilan.ok.push(c.email)
    fait = true
  }
  if (!fait) bilan.ignorees.push(c.email)
}

console.log(`\nImportées : ${bilan.ok.length}${bilan.ignorees.length ? ` — non importées : ${bilan.ignorees.join(', ')}` : ''}`)
console.log('Relance Assistant Mail pour qu\u2019il prenne en compte les nouvelles boîtes.')
