import type { SoumissionLocale } from '@kalebax/storage';
import { versSortante, type SoumissionSortante } from './transport.js';

/**
 * Bornes d'un lot — docs/synchronisation.md §5.1.
 *
 * Deux limites, pas une. Un lot trop gros ne passe jamais sur un réseau qui
 * coupe toutes les vingt secondes ; un lot d'une seule soumission gaspille la
 * latence, qui domine tout le reste en 2G.
 */
export const TAILLE_LOT_MAX = 25;
export const OCTETS_LOT_MAX = 512 * 1024;

export interface Lot {
  readonly soumissions: readonly SoumissionLocale[];
  readonly sortantes: readonly SoumissionSortante[];
  readonly octetsEstimes: number;
}

/**
 * Découpe la file en lots respectant les deux bornes.
 *
 * Une soumission qui dépasse à elle seule la limite d'octets part quand même,
 * seule dans son lot : la refuser la bloquerait pour toujours, et une donnée de
 * terrain ne se jette pas parce qu'elle est encombrante.
 */
export function decouperEnLots(
  soumissions: readonly SoumissionLocale[],
  tailleMax = TAILLE_LOT_MAX,
  octetsMax = OCTETS_LOT_MAX,
): Lot[] {
  const lots: Lot[] = [];
  let courant: SoumissionLocale[] = [];
  let octets = 0;

  const clore = (): void => {
    if (courant.length === 0) return;
    lots.push({
      soumissions: courant,
      sortantes: courant.map(versSortante),
      octetsEstimes: octets,
    });
    courant = [];
    octets = 0;
  };

  for (const soumission of soumissions) {
    const taille = estimerOctets(soumission);
    const depasseNombre = courant.length >= tailleMax;
    const depasseTaille = courant.length > 0 && octets + taille > octetsMax;
    if (depasseNombre || depasseTaille) clore();

    courant.push(soumission);
    octets += taille;
  }
  clore();

  return lots;
}

/**
 * Estimation de la taille sur le réseau.
 *
 * Approximation volontaire : mesurer exactement supposerait de sérialiser deux
 * fois, et l'écart ne change rien à la décision. La compression réduira encore
 * ce volume d'un facteur cinq à dix, les bornes sont donc prudentes.
 */
export function estimerOctets(soumission: SoumissionLocale): number {
  return JSON.stringify(versSortante(soumission)).length;
}
