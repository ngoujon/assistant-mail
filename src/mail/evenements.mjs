// Petit bus d'événements : le moteur de transfert y publie sa progression et sa
// fin, l'interface et la session s'y abonnent. Aucun état, aucune dépendance.
const abonnesProgres = new Set()
const abonnesFin = new Set()

export function onProgress(fn) {
  abonnesProgres.add(fn)
  return () => abonnesProgres.delete(fn)
}

export function emitProgress(evt) {
  for (const fn of abonnesProgres) { try { fn(evt) } catch {} }
}

/** Fin d'un traitement parti en arrière-plan : de quoi prévenir l'assistant. */
export function onDone(fn) {
  abonnesFin.add(fn)
  return () => abonnesFin.delete(fn)
}

export function emitDone(rapport) {
  for (const fn of abonnesFin) { try { fn(rapport) } catch {} }
}
