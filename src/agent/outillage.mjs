// Le petit outillage qui remplace le SDK : déclarer un outil, le décrire au
// modèle en JSON Schema, et remettre d'aplomb les arguments qu'un modèle local
// produit parfois de travers (un objet passé sous forme de chaîne, un « null »
// écrit en toutes lettres…). Le but est de ne pas renvoyer le modèle en boucle
// sur une erreur de syntaxe alors que son intention était claire.
import { z } from 'zod'

/**
 * Déclare un outil. Même signature que celle du SDK, pour que les définitions
 * d'outils mail n'aient pas eu à changer.
 * @param {string} nom
 * @param {string} description
 * @param {object} forme  dictionnaire de schémas zod
 * @param {Function} handler
 */
export function tool(nom, description, forme, handler) {
  return { name: nom, description, schema: z.object(forme || {}), handler }
}

/** Regroupe des outils sous un nom. */
export function createSdkMcpServer({ name, version, instructions, tools }) {
  return { name, version, instructions, tools }
}

/** La description d'un outil telle que l'attend une API OpenAI-compatible. */
export function descriptionOutil(outil) {
  const params = z.toJSONSchema(outil.schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' })
  delete params.$schema
  return {
    type: 'function',
    function: {
      name: outil.name,
      description: outil.description,
      parameters: { type: 'object', properties: {}, ...params },
    },
  }
}

/**
 * Valide les arguments d'un appel d'outil.
 * @returns {{ok: true, valeur: object} | {ok: false, message: string}}
 */
export function validerArguments(outil, brut) {
  const args = reparer(brut, outil.schema)
  const r = outil.schema.safeParse(args)
  if (r.success) return { ok: true, valeur: r.data }
  const details = (r.error?.issues || [])
    .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
    .slice(0, 6)
    .join(' ; ')
  return { ok: false, message: details || 'arguments invalides' }
}

/** Corrige les maladresses courantes d'un modèle local sans rien deviner. */
function reparer(brut, schema) {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return brut
  const formes = schema?.shape || {}
  const sortie = {}
  for (const [cle, valeur] of Object.entries(brut)) {
    if (valeur === null || valeur === undefined) continue
    if (typeof valeur === 'string') {
      const t = valeur.trim()
      // Un champ laissé vide vaut « non renseigné », pas la chaîne « null ».
      if (t === '' || t === 'null' || t === 'undefined' || t === 'None') continue
      // Un objet ou un tableau sérialisé en chaîne : on le rouvre.
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          const parse = JSON.parse(t)
          sortie[cle] = formes[cle] ? reparer(parse, formes[cle]) : parse
          continue
        } catch {}
      }
      const attendu = typeNu(formes[cle])
      if (attendu === 'number' && /^-?\d+(\.\d+)?$/.test(t)) { sortie[cle] = Number(t); continue }
      if (attendu === 'boolean' && /^(true|false)$/i.test(t)) { sortie[cle] = /^true$/i.test(t); continue }
    }
    sortie[cle] = formes[cle]?.shape && typeof valeur === 'object' ? reparer(valeur, formes[cle]) : valeur
  }
  return sortie
}

/** Le type d'un schéma zod, en traversant les enveloppes optional/default. */
function typeNu(schema) {
  let s = schema
  for (let i = 0; s && i < 5; i++) {
    const t = s._zod?.def?.type || s.def?.type
    if (t === 'optional' || t === 'nullable' || t === 'default') {
      s = s._zod?.def?.innerType || s.def?.innerType
      continue
    }
    return t
  }
  return undefined
}

/** Le texte d'un résultat d'outil, quelle qu'en soit la forme. */
export function texteResultat(sortie) {
  if (typeof sortie === 'string') return sortie
  const contenu = sortie?.content
  if (typeof contenu === 'string') return contenu
  if (Array.isArray(contenu)) {
    return contenu.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return JSON.stringify(sortie ?? null)
}
