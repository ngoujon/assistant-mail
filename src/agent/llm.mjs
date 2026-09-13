// Le moteur de l'assistant : un serveur OpenAI-compatible qui tourne sur le
// réseau local (LM Studio, llama.cpp, Ollama…). Rien ne sort de la maison —
// aucun appel à une API distante, aucune clé, aucune donnée de boîte mail
// envoyée sur Internet. Si le serveur est éteint, l'app le dit et s'arrête là.

export class ErreurIA extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'ErreurIA'
  }
}

/** Le modèle n'a plus de place : la fenêtre de contexte est trop petite. */
export class ErreurContexte extends ErreurIA {
  constructor(message) {
    super(message)
    this.name = 'ErreurContexte'
  }
}

const SIGNE_CONTEXTE = /context (size|length|window)|contexte|too many tokens|exceed/i

const CONSEIL_CONTEXTE =
  "Le modèle n'a plus de place : sa fenêtre de contexte ne suffit pas aux consignes et aux outils de l'assistant. " +
  'Dans ton serveur local, recharge le modèle avec une longueur de contexte plus grande — 16 000 jetons au minimum, ' +
  '32 000 pour être tranquille — et, si la génération spéculative est activée, vérifie la fenêtre du modèle brouillon, ' +
  "qui plafonne souvent à 4 096 jetons et bride tout le reste."

/** Traduit une erreur du serveur, en reconnaissant le manque de contexte. */
function erreurServeur(texte, prefixe) {
  const t = String(texte || '')
  if (SIGNE_CONTEXTE.test(t)) return new ErreurContexte(CONSEIL_CONTEXTE)
  return new ErreurIA(`${prefixe}${t ? ` : ${tronquer(t)}` : ''}.`)
}

const base = (url) => String(url || '').trim().replace(/\/+$/, '')

function entetes(apiKey) {
  const h = { 'Content-Type': 'application/json' }
  // LM Studio n'en demande pas ; certains serveurs locaux exigent un jeton bidon.
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

const tronquer = (s, n = 300) => {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** La liste des modèles chargés par le serveur. Sert aussi de test de vie. */
export async function listerModeles({ baseUrl, apiKey, signal } = {}) {
  const url = `${base(baseUrl)}/models`
  let r
  try {
    r = await fetch(url, { headers: entetes(apiKey), signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ErreurIA(`Serveur d'IA injoignable sur ${base(baseUrl)} — ${err?.message || err}`, { cause: err })
  }
  if (!r.ok) throw new ErreurIA(`Le serveur a répondu ${r.status} sur ${url}.`)
  const data = await r.json().catch(() => null)
  return (data?.data || []).map((m) => m?.id).filter(Boolean)
}

/**
 * Un tour de modèle, en flux. Le texte et le raisonnement arrivent au fil de
 * l'eau ; les appels d'outils sont recomposés morceau par morceau.
 * @returns {Promise<{contenu: string, pensee: string, appels: Array, raison: string}>}
 */
export async function completer({
  baseUrl, apiKey, model, messages, tools, temperature = 0.3, maxTokens,
  signal, onTexte, onPensee,
}) {
  const url = `${base(baseUrl)}/chat/completions`
  const corps = {
    model,
    messages,
    stream: true,
    temperature,
    // Pas de `max_tokens` : un serveur local réserve la place demandée dans la
    // fenêtre de contexte, et une valeur généreuse la remplit à elle seule.
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  }

  let r
  try {
    r = await fetch(url, { method: 'POST', headers: entetes(apiKey), body: JSON.stringify(corps), signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ErreurIA(
      `Serveur d'IA injoignable sur ${base(baseUrl)} — ${err?.message || err}. ` +
      'Vérifie que le serveur local tourne et que le modèle est chargé.',
      { cause: err },
    )
  }
  if (!r.ok || !r.body) {
    const detail = await r.text?.().catch(() => '') || ''
    throw erreurServeur(detail, `Le serveur d'IA a répondu ${r.status}`)
  }

  const etat = {
    contenu: '', pensee: '', raison: '',
    appels: new Map(),
    // Certains serveurs ne séparent pas le raisonnement : il arrive dans le
    // texte, entre <think> et </think>. On le range au bon endroit.
    dansPensee: false,
    reste: '',
  }

  const decodeur = new TextDecoder()
  const lecteur = r.body.getReader()
  let tampon = ''

  try {
    while (true) {
      const { value, done } = await lecteur.read()
      if (done) break
      tampon += decodeur.decode(value, { stream: true })
      let coupe
      while ((coupe = tampon.indexOf('\n')) >= 0) {
        const ligne = tampon.slice(0, coupe).trim()
        tampon = tampon.slice(coupe + 1)
        if (!ligne || ligne.startsWith(':') || !ligne.startsWith('data:')) continue
        const charge = ligne.slice(5).trim()
        if (charge === '[DONE]') { tampon = ''; break }
        let evt
        try { evt = JSON.parse(charge) } catch { continue }
        avaler(etat, evt, { onTexte, onPensee })
      }
    }
  } finally {
    try { await lecteur.cancel() } catch {}
  }

  viderTexte(etat, { onTexte, onPensee })

  return {
    contenu: etat.contenu,
    pensee: etat.pensee,
    raison: etat.raison,
    appels: [...etat.appels.values()]
      .filter((a) => a.nom)
      .map((a, i) => ({ id: a.id || `appel-${Date.now()}-${i}`, nom: a.nom, arguments: a.arguments })),
  }
}

function avaler(etat, evt, cb) {
  const choix = evt?.choices?.[0]
  if (!choix) {
    // Une erreur peut arriver en plein flux : le serveur la glisse dans un événement.
    if (evt?.error) throw erreurServeur(evt.error.message || evt.error, "Le serveur d'IA a signalé une erreur")
    return
  }
  if (choix.finish_reason) etat.raison = choix.finish_reason
  const d = choix.delta || choix.message || {}

  const pensee = d.reasoning_content ?? d.reasoning
  if (pensee) { etat.pensee += pensee; cb.onPensee?.(pensee) }

  if (typeof d.content === 'string' && d.content) texteBrut(etat, d.content, cb)

  for (const tc of d.tool_calls || []) {
    const cle = tc.index ?? tc.id ?? etat.appels.size
    const courant = etat.appels.get(cle) || { id: '', nom: '', arguments: '' }
    if (tc.id) courant.id = tc.id
    if (tc.function?.name) courant.nom = tc.function.name
    if (tc.function?.arguments) courant.arguments += tc.function.arguments
    etat.appels.set(cle, courant)
  }
}

/** Sépare le texte du raisonnement balisé <think>…</think>. */
function texteBrut(etat, morceau, cb) {
  let s = etat.reste + morceau
  etat.reste = ''
  while (true) {
    const balise = etat.dansPensee ? '</think>' : '<think>'
    const i = s.indexOf(balise)
    if (i >= 0) {
      emettre(etat, s.slice(0, i), cb)
      s = s.slice(i + balise.length)
      etat.dansPensee = !etat.dansPensee
      continue
    }
    // Une balise peut être coupée en deux entre deux morceaux du flux : on
    // retient la fin qui pourrait en être le début, et on la recollera après.
    const dernier = s.lastIndexOf('<')
    if (dernier >= 0 && balise.startsWith(s.slice(dernier))) {
      emettre(etat, s.slice(0, dernier), cb)
      etat.reste = s.slice(dernier)
    } else {
      emettre(etat, s, cb)
    }
    return
  }
}

function emettre(etat, texte, cb) {
  if (!texte) return
  if (etat.dansPensee) { etat.pensee += texte; cb.onPensee?.(texte) }
  else { etat.contenu += texte; cb.onTexte?.(texte) }
}

function viderTexte(etat, cb) {
  if (etat.reste) { emettre(etat, etat.reste, cb); etat.reste = '' }
}

/**
 * La fenêtre de contexte du modèle chargé, si le serveur sait la dire.
 * LM Studio l'expose sur sa propre API REST, à côté de l'API OpenAI ; les
 * autres serveurs ne répondent pas, et on s'en passe.
 * @returns {Promise<number|null>}
 */
export async function contexteCharge({ baseUrl, apiKey, model, signal } = {}) {
  const racine = base(baseUrl).replace(/\/v1$/, '')
  try {
    const r = await fetch(`${racine}/api/v0/models`, { headers: entetes(apiKey), signal })
    if (!r.ok) return null
    const d = await r.json()
    const m = (d?.data || []).find((x) => x.id === model)
    return m?.loaded_context_length || m?.max_context_length || null
  } catch {
    return null
  }
}
