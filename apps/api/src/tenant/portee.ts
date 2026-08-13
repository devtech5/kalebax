import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ContexteAppelant } from './contexte.js';

/**
 * Deuxième couche d'isolement multi-tenant — docs/authentification.md §5.
 *
 * Aucun service métier ne construit un filtre d'organisation à la main : il
 * passe par ces fonctions. Une seule couche finit toujours par être contournée
 * un jour de hâte, et un `where` oublié expose les données d'un client à un
 * autre.
 */

/** Ajoute `organizationId` à un filtre de lecture. */
export function porteeLecture<T extends Record<string, unknown>>(
  contexte: ContexteAppelant,
  filtre: T = {} as T,
): T & { organizationId: string } {
  return { ...filtre, organizationId: contexte.organizationId };
}

/**
 * Ajoute `organizationId` à des données de création, en **écrasant** toute
 * valeur fournie par l'appelant.
 *
 * Un `organizationId` présent dans le corps d'une requête n'est pas une erreur
 * à signaler : c'est une valeur à ignorer. La signaler apprendrait à un
 * attaquant que le champ est interprété quelque part.
 */
export function porteeCreation<T extends Record<string, unknown>>(
  contexte: ContexteAppelant,
  donnees: T,
): Omit<T, 'organizationId'> & { organizationId: string } {
  const { organizationId: _ignore, ...reste } = donnees;
  return { ...reste, organizationId: contexte.organizationId };
}

/**
 * Vérifie qu'une ressource lue appartient bien à l'organisation appelante.
 *
 * Rend **404 et non 403** : un 403 confirmerait l'existence de la ressource, ce
 * qui permettrait d'énumérer les identifiants d'un concurrent.
 */
export function exigerAppartenance<T extends { organizationId: string } | null>(
  contexte: ContexteAppelant,
  ressource: T,
  libelle = 'Ressource',
): NonNullable<T> {
  if (ressource === null || ressource.organizationId !== contexte.organizationId) {
    throw new NotFoundException(`${libelle} introuvable.`);
  }
  return ressource as NonNullable<T>;
}

/**
 * Interdit toute écriture à une appartenance révoquée, sauf l'envoi de ce qui a
 * déjà été collecté.
 *
 * Perdre une semaine de collecte de terrain parce qu'un compte a été fermé le
 * lundi serait une faute produit.
 */
export function exigerActif(contexte: ContexteAppelant): void {
  if (contexte.revoque) {
    throw new ForbiddenException(
      "Votre accès à cette organisation a été retiré. Vos données déjà collectées peuvent encore être envoyées, mais aucune nouvelle collecte n'est possible.",
    );
  }
}

/** Une organisation en lecture seule — abonnement expiré — n'accepte plus d'écriture. */
export function exigerOrganisationInscriptible(statut: string): void {
  if (statut === 'active') return;
  throw new ForbiddenException(
    statut === 'readonly'
      ? "Cette organisation est en lecture seule : la consultation et l'export restent possibles, la collecte est arrêtée."
      : 'Cette organisation est suspendue.',
  );
}
