import type { RoleJeton } from '../auth/jetons.service.js';

/**
 * Identité de l'appelant, telle qu'elle sort du jeton — docs/authentification.md §5.
 *
 * `organizationId` vient **toujours** d'ici, jamais du corps d'une requête ni
 * d'un paramètre d'URL. C'est la règle qui tient tout l'isolement multi-tenant.
 */
export interface ContexteAppelant {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: RoleJeton;
  /** Identifiant du jeton de rafraîchissement, pour révoquer une session précise. */
  readonly sessionId: string;
  /**
   * Vrai lorsque l'appartenance a été révoquée. L'appelant conserve alors le
   * droit d'envoyer ce qu'il a déjà collecté, et rien d'autre.
   */
  readonly revoque: boolean;
}

/** Clé sous laquelle le garde dépose le contexte sur la requête. */
export const CLE_CONTEXTE = 'kalebaxContexte' as const;

export interface RequeteAvecContexte {
  [CLE_CONTEXTE]?: ContexteAppelant;
}

/** Hiérarchie des rôles : chacun couvre les droits de ceux qui le suivent. */
const RANG: Readonly<Record<RoleJeton, number>> = {
  owner: 5,
  admin: 4,
  designer: 3,
  supervisor: 2,
  agent: 1,
};

export function auMoins(role: RoleJeton, minimum: RoleJeton): boolean {
  return RANG[role] >= RANG[minimum];
}

/**
 * Un agent ne lit jamais les soumissions d'un autre agent.
 *
 * La règle est ici plutôt que dispersée dans les services : elle doit avoir une
 * seule formulation, sans quoi une route finira par l'oublier.
 */
export function peutVoirToutesLesSoumissions(role: RoleJeton): boolean {
  return auMoins(role, 'supervisor');
}
