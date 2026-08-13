import type { RoleJeton } from './jetons.service.js';

/**
 * Ce que le garde a besoin de savoir sur une appartenance, et rien de plus.
 *
 * Un port plutôt qu'un appel direct à Prisma : le garde porte les règles
 * d'accès les plus sensibles du produit, elles doivent être testables sans base
 * de données, sinon elles ne seront pas testées assez.
 */
export interface EtatAppartenance {
  readonly role: RoleJeton;
  readonly revoque: boolean;
  /** `active`, `readonly` ou `suspended`. */
  readonly statutOrganisation: string;
  readonly utilisateurActif: boolean;
}

export interface LecteurAppartenances {
  lire(userId: string, organizationId: string): Promise<EtatAppartenance | null>;
}

/** Jeton d'injection Nest — une interface n'existe pas à l'exécution. */
export const LECTEUR_APPARTENANCES = Symbol('LecteurAppartenances');

/**
 * Vérifie qu'une session est toujours révocable en cours de route.
 *
 * Un jeton d'accès vit quinze minutes : sans cette relecture, une révocation
 * mettrait un quart d'heure à produire son effet. La lecture est faite à chaque
 * requête, et c'est le prix à payer.
 */
export const TOLERANCE_REVOCATION_SECONDES = 0;
