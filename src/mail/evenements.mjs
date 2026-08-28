// Petit bus d'événements : le moteur de transfert y publie sa progression,
// l'interface s'y abonne. Aucun état, aucune dépendance.
const abonnes = new Set()

export function onProgress(fn) {
  abonnes.add(fn)
  return () => abonnes.delete(fn)
}

export function emitProgress(evt) {
  for (const fn of abonnes) {
    try { fn(evt) } catch {}
  }
}
