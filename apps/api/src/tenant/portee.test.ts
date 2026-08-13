import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { auMoins, peutVoirToutesLesSoumissions, type ContexteAppelant } from './contexte.js';
import {
  exigerActif,
  exigerAppartenance,
  exigerOrganisationInscriptible,
  porteeCreation,
  porteeLecture,
} from './portee.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

function contexte(extra: Partial<ContexteAppelant> = {}): ContexteAppelant {
  return {
    userId: 'user-1',
    organizationId: ORG_A,
    role: 'designer',
    sessionId: 'session-1',
    revoque: false,
    ...extra,
  };
}

describe('portée de lecture', () => {
  it('ajoute l\'organisation au filtre', () => {
    expect(porteeLecture(contexte(), { status: 'active' })).toEqual({
      status: 'active',
      organizationId: ORG_A,
    });
  });

  it('fonctionne sans filtre de départ', () => {
    expect(porteeLecture(contexte())).toEqual({ organizationId: ORG_A });
  });
});

describe('portée de création', () => {
  it('impose l\'organisation du jeton', () => {
    expect(porteeCreation(contexte(), { name: 'Projet' })).toEqual({
      name: 'Projet',
      organizationId: ORG_A,
    });
  });

  it('écrase silencieusement une organisation fournie par l\'appelant', () => {
    // Signaler la tentative apprendrait qu'un tel champ est interprété
    // quelque part.
    const resultat = porteeCreation(contexte(), { name: 'Projet', organizationId: ORG_B });
    expect(resultat.organizationId).toBe(ORG_A);
  });
});

describe('appartenance d\'une ressource', () => {
  it('laisse passer une ressource de la même organisation', () => {
    const ressource = { organizationId: ORG_A, name: 'Projet' };
    expect(exigerAppartenance(contexte(), ressource)).toBe(ressource);
  });

  it('rend 404 et non 403 sur une ressource d\'une autre organisation', () => {
    // Un 403 confirmerait l'existence de la ressource et permettrait
    // d'énumérer les identifiants d'un concurrent.
    expect(() => exigerAppartenance(contexte(), { organizationId: ORG_B })).toThrow(
      NotFoundException,
    );
  });

  it('rend 404 sur une ressource absente', () => {
    expect(() => exigerAppartenance(contexte(), null)).toThrow(NotFoundException);
  });

  it('donne le même message dans les deux cas', () => {
    // Rien ne doit distinguer « n'existe pas » de « ne vous appartient pas ».
    const absente = attraper(() => exigerAppartenance(contexte(), null, 'Soumission'));
    const etrangere = attraper(() =>
      exigerAppartenance(contexte(), { organizationId: ORG_B }, 'Soumission'),
    );
    expect(absente).toBe(etrangere);
  });
});

describe('appartenance révoquée', () => {
  it('laisse travailler un membre actif', () => {
    expect(() => exigerActif(contexte())).not.toThrow();
  });

  it('interdit toute nouvelle écriture à un membre révoqué', () => {
    expect(() => exigerActif(contexte({ revoque: true }))).toThrow(ForbiddenException);
  });
});

describe('organisation en lecture seule', () => {
  it('accepte les écritures sur une organisation active', () => {
    expect(() => exigerOrganisationInscriptible('active')).not.toThrow();
  });

  it('refuse les écritures sur un abonnement expiré, sans perdre de données', () => {
    expect(() => exigerOrganisationInscriptible('readonly')).toThrow(ForbiddenException);
    expect(() => exigerOrganisationInscriptible('suspended')).toThrow(ForbiddenException);
  });
});

describe('hiérarchie des rôles', () => {
  it('couvre les rôles inférieurs', () => {
    expect(auMoins('owner', 'agent')).toBe(true);
    expect(auMoins('admin', 'designer')).toBe(true);
    expect(auMoins('agent', 'supervisor')).toBe(false);
    expect(auMoins('designer', 'admin')).toBe(false);
  });

  it('réserve la lecture de toutes les soumissions aux superviseurs', () => {
    // Un agent ne lit jamais les soumissions d'un autre agent.
    expect(peutVoirToutesLesSoumissions('agent')).toBe(false);
    expect(peutVoirToutesLesSoumissions('supervisor')).toBe(true);
    expect(peutVoirToutesLesSoumissions('owner')).toBe(true);
  });
});

function attraper(action: () => unknown): string {
  try {
    action();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
