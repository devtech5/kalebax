/**
 * Temporisation entre deux tentatives — docs/synchronisation.md §8.
 *
 * Les paliers montent vite puis se stabilisent à l'heure : un réseau absent le
 * reste souvent des heures, et sonder toutes les cinq secondes vide la batterie
 * sans rien gagner.
 */
export const PALIERS_SECONDES: readonly number[] = [5, 15, 60, 300, 900, 3600];

/**
 * Amplitude de la variation aléatoire appliquée à chaque délai.
 *
 * Sans elle, cinquante agents qui retrouvent le réseau au même moment — à la fin
 * d'une réunion d'équipe, en rentrant au bureau régional — frappent le serveur
 * au même instant, échouent ensemble, et recommencent ensemble.
 */
export const VARIATION = 0.2;

/**
 * Délai avant la prochaine tentative, en millisecondes.
 *
 * `hasard` est injectable pour que le calcul reste vérifiable : une fonction
 * dont le résultat dépend du hasard sans qu'on puisse le fixer n'est pas
 * testable.
 */
export function delaiTentative(
  nombreTentatives: number,
  hasard: () => number = Math.random,
): number {
  const index = Math.min(Math.max(nombreTentatives, 0), PALIERS_SECONDES.length - 1);
  const base = (PALIERS_SECONDES[index] ?? 3600) * 1000;
  // hasard() ∈ [0,1) devient un facteur dans [0,8 ; 1,2].
  const facteur = 1 - VARIATION + hasard() * VARIATION * 2;
  return Math.round(base * facteur);
}

export function prochaineTentative(
  nombreTentatives: number,
  maintenant: Date = new Date(),
  hasard: () => number = Math.random,
): Date {
  return new Date(maintenant.getTime() + delaiTentative(nombreTentatives, hasard));
}
