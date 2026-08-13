import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { EtatAppartenance, LecteurAppartenances } from './appartenances.port.js';
import { AuthGuard } from './auth.guard.js';
import { JetonsService } from './jetons.service.js';
import { CLE_CONTEXTE, type ContexteAppelant } from '../tenant/contexte.js';
import type { ExecutionContext } from '@nestjs/common';

const USER = 'user-1';
const ORG = 'org-1';

function appartenance(extra: Partial<EtatAppartenance> = {}): EtatAppartenance {
  return {
    role: 'agent',
    revoque: false,
    statutOrganisation: 'active',
    utilisateurActif: true,
    ...extra,
  };
}

function lecteur(etat: EtatAppartenance | null): LecteurAppartenances {
  return { lire: async () => etat };
}

// Cibles de métadonnées : le Reflector de Nest les passe à
// `Reflect.getMetadata`, qui refuse `undefined`.
class ControleurFictif {}
function routeFictive(): void {}

/** Fabrique un ExecutionContext minimal autour d'un en-tête d'autorisation. */
function execution(
  entete: string | undefined,
  requete: Record<string, unknown> = {},
): ExecutionContext {
  Object.assign(requete, { headers: entete === undefined ? {} : { authorization: entete } });
  return {
    switchToHttp: () => ({ getRequest: () => requete }),
    getHandler: () => routeFictive,
    getClass: () => ControleurFictif,
  } as unknown as ExecutionContext;
}

async function garde(
  etat: EtatAppartenance | null = appartenance(),
): Promise<{ garde: AuthGuard; jetons: JetonsService }> {
  const jetons = new JetonsService();
  return { garde: new AuthGuard(jetons, new Reflector(), lecteur(etat)), jetons };
}

describe('extraction du jeton', () => {
  it('refuse une requête sans en-tête', async () => {
    const { garde: g } = await garde();
    await expect(g.canActivate(execution(undefined))).rejects.toThrow(UnauthorizedException);
  });

  it('refuse un schéma d\'autorisation inconnu', async () => {
    const { garde: g, jetons } = await garde();
    const jeton = await jetons.signerAcces({ sub: USER, org: ORG, role: 'agent', sid: 's' });
    await expect(g.canActivate(execution(`Basic ${jeton}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepte une casse variable du schéma', async () => {
    const { garde: g, jetons } = await garde();
    const jeton = await jetons.signerAcces({ sub: USER, org: ORG, role: 'agent', sid: 's' });
    await expect(g.canActivate(execution(`bearer ${jeton}`))).resolves.toBe(true);
  });

  it('refuse un jeton vide', async () => {
    const { garde: g } = await garde();
    await expect(g.canActivate(execution('Bearer '))).rejects.toThrow(UnauthorizedException);
  });

  it('refuse un jeton forgé', async () => {
    const { garde: g } = await garde();
    await expect(g.canActivate(execution('Bearer nimporte.quoi.ici'))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('contexte déposé sur la requête', () => {
  it('porte l\'utilisateur, l\'organisation et la session', async () => {
    const { garde: g, jetons } = await garde();
    const jeton = await jetons.signerAcces({
      sub: USER,
      org: ORG,
      role: 'agent',
      sid: 'session-42',
    });
    const requete: Record<string, unknown> = {};
    await g.canActivate(execution(`Bearer ${jeton}`, requete));

    const contexte = requete[CLE_CONTEXTE] as ContexteAppelant;
    expect(contexte).toEqual({
      userId: USER,
      organizationId: ORG,
      role: 'agent',
      sessionId: 'session-42',
      revoque: false,
    });
  });

  it('prend le rôle dans la base et non dans le jeton', async () => {
    // Une rétrogradation doit prendre effet immédiatement, sans attendre
    // l'expiration du jeton d'accès.
    const { garde: g, jetons } = await garde(appartenance({ role: 'agent' }));
    const jeton = await jetons.signerAcces({ sub: USER, org: ORG, role: 'owner', sid: 's' });
    const requete: Record<string, unknown> = {};
    await g.canActivate(execution(`Bearer ${jeton}`, requete));

    expect((requete[CLE_CONTEXTE] as ContexteAppelant).role).toBe('agent');
  });

  it('signale une appartenance révoquée sans refuser la requête', async () => {
    // Un membre révoqué doit pouvoir envoyer ce qu'il a déjà collecté.
    const { garde: g, jetons } = await garde(appartenance({ revoque: true }));
    const jeton = await jetons.signerAcces({ sub: USER, org: ORG, role: 'agent', sid: 's' });
    const requete: Record<string, unknown> = {};

    await expect(g.canActivate(execution(`Bearer ${jeton}`, requete))).resolves.toBe(true);
    expect((requete[CLE_CONTEXTE] as ContexteAppelant).revoque).toBe(true);
  });
});

describe('appartenance absente ou compte fermé', () => {
  it('refuse un jeton portant une organisation à laquelle l\'utilisateur n\'appartient pas', async () => {
    const { garde: g, jetons } = await garde(null);
    const jeton = await jetons.signerAcces({
      sub: USER,
      org: 'org-dun-concurrent',
      role: 'owner',
      sid: 's',
    });
    await expect(g.canActivate(execution(`Bearer ${jeton}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un utilisateur suspendu', async () => {
    const { garde: g, jetons } = await garde(appartenance({ utilisateurActif: false }));
    const jeton = await jetons.signerAcces({ sub: USER, org: ORG, role: 'agent', sid: 's' });
    await expect(g.canActivate(execution(`Bearer ${jeton}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('donne le même message quel que soit le motif du refus', async () => {
    // Rien ne doit permettre de distinguer un jeton expiré d'une organisation
    // à laquelle on n'appartient pas.
    const sansAppartenance = await garde(null);
    const jetonValide = await sansAppartenance.jetons.signerAcces({
      sub: USER,
      org: ORG,
      role: 'agent',
      sid: 's',
    });

    const messageAppartenance = await attraper(() =>
      sansAppartenance.garde.canActivate(execution(`Bearer ${jetonValide}`)),
    );
    const messageForge = await attraper(() =>
      sansAppartenance.garde.canActivate(execution('Bearer a.b.c')),
    );

    expect(messageAppartenance).toBe(messageForge);
  });
});

async function attraper(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
