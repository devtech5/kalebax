import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { BasePrismaSoumissions } from './prisma-memoire-soumissions.js';
import { SoumissionsService, type SoumissionEntrante } from './soumissions.service.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const PROJET = randomUUID();
const VERSION = randomUUID();
const AGENT = randomUUID();
const AUTRE_AGENT = randomUUID();

let base: BasePrismaSoumissions;
let service: SoumissionsService;

function contexte(extra: Partial<ContexteAppelant> = {}): ContexteAppelant {
  return {
    userId: AGENT,
    organizationId: ORG_A,
    role: 'agent',
    sessionId: 'session-1',
    revoque: false,
    ...extra,
  };
}

const DOCUMENT = {
  schemaVersion: 1,
  title: { fr: 'Relevé' },
  defaultLanguage: 'fr',
  languages: ['fr'],
  children: [
    { id: 'q_nom', name: 'nom', type: 'text', label: { fr: 'Nom' }, required: true },
    {
      id: 'q_prix',
      name: 'prix',
      type: 'integer',
      label: { fr: 'Prix' },
      constraint: '. > 0',
    },
  ],
};

function entrante(extra: Partial<SoumissionEntrante> = {}): SoumissionEntrante {
  return {
    id: randomUUID(),
    formVersionId: VERSION,
    data: { nom: 'Boutique Awa', prix: 500 },
    startedAt: '2026-08-13T09:00:00.000Z',
    completedAt: '2026-08-13T09:12:30.000Z',
    ...extra,
  };
}

beforeEach(() => {
  base = new BasePrismaSoumissions();
  service = new SoumissionsService(base.enServicePrisma());
  base.versions.push({
    id: VERSION,
    organizationId: ORG_A,
    status: 'published',
    schema: DOCUMENT,
    projectId: PROJET,
  });
});

describe('réception', () => {
  it('accepte une soumission conforme', async () => {
    const resultat = await service.recevoir(contexte(), entrante());
    expect(resultat.status).toBe('received');
    expect(resultat.deja).toBe(false);
    expect(resultat.violations).toHaveLength(0);
  });

  it('calcule la durée de saisie', async () => {
    await service.recevoir(contexte(), entrante());
    expect(base.soumissions[0]!.durationSeconds).toBe(750);
  });

  it('enregistre quand même une soumission en violation', async () => {
    // Perdre une donnée de terrain parce qu'elle ne passe pas une contrainte
    // est pire que la conserver pour arbitrage humain.
    const resultat = await service.recevoir(
      contexte(),
      entrante({ data: { nom: 'Boutique', prix: -5 } }),
    );
    expect(resultat.status).toBe('rejected');
    expect(resultat.violations.length).toBeGreaterThan(0);
    expect(base.soumissions).toHaveLength(1);
  });

  it('conserve les réponses inconnues plutôt que de les jeter', async () => {
    await service.recevoir(
      contexte(),
      entrante({ data: { nom: 'Boutique', ancien_champ: 'valeur' } }),
    );
    expect(base.soumissions[0]!.extraData).toEqual({ ancien_champ: 'valeur' });
  });

  it('refuse une version en brouillon', async () => {
    base.versions[0]!.status = 'draft';
    await expect(service.recevoir(contexte(), entrante())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepte une version retirée', async () => {
    // Interrompre un agent en pleine visite parce que le formulaire a été mis à
    // jour est inacceptable.
    base.versions[0]!.status = 'retired';
    await expect(service.recevoir(contexte(), entrante())).resolves.toBeDefined();
  });

  it('conserve le statut de capture GPS', async () => {
    await service.recevoir(contexte(), entrante({ startGeopointStatus: 'denied' }));
    expect(base.soumissions[0]!.startGeopointStatus).toBe('denied');
  });

  it('laisse un membre révoqué envoyer ce qu\'il a déjà collecté', async () => {
    await expect(
      service.recevoir(contexte({ revoque: true }), entrante()),
    ).resolves.toBeDefined();
  });
});

describe('idempotence', () => {
  it('ne duplique pas une soumission rejouée', async () => {
    // Rejouer une synchronisation interrompue est le cas normal, pas
    // l'exception.
    const soumission = entrante();
    const premier = await service.recevoir(contexte(), soumission);
    const second = await service.recevoir(contexte(), soumission);

    expect(second.id).toBe(premier.id);
    expect(second.deja).toBe(true);
    expect(base.soumissions).toHaveLength(1);
  });

  it('ne modifie rien lors du rejeu, même avec des données différentes', async () => {
    const id = randomUUID();
    await service.recevoir(contexte(), entrante({ id, data: { nom: 'Origine' } }));
    await service.recevoir(contexte(), entrante({ id, data: { nom: 'Falsifié' } }));

    expect(base.soumissions[0]!.data).toEqual({ nom: 'Origine' });
  });

  it('supporte dix rejeux sans produire de doublon', async () => {
    const soumission = entrante();
    for (let i = 0; i < 10; i += 1) {
      await service.recevoir(contexte(), soumission);
    }
    expect(base.soumissions).toHaveLength(1);
    expect(base.revisionsEnregistrees).toHaveLength(1);
  });

  it('rend introuvable un identifiant déjà pris dans une autre organisation', async () => {
    const soumission = entrante();
    await service.recevoir(contexte(), soumission);
    base.versions.push({
      id: 'v-b',
      organizationId: ORG_B,
      status: 'published',
      schema: DOCUMENT,
      projectId: 'p-b',
    });

    await expect(
      service.recevoir(contexte({ organizationId: ORG_B }), {
        ...soumission,
        formVersionId: 'v-b',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('immuabilité et révisions', () => {
  it('écrit la révision 1 à la réception', async () => {
    // L'état d'origine, tel que l'agent l'a soumis, reste toujours
    // récupérable.
    await service.recevoir(contexte(), entrante());
    expect(base.revisionsEnregistrees).toHaveLength(1);
    expect(base.revisionsEnregistrees[0]!.revision).toBe(1);
    expect(base.revisionsEnregistrees[0]!.data).toEqual({
      nom: 'Boutique Awa',
      prix: 500,
    });
  });

  it('crée une révision à chaque correction', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    const superviseur = contexte({ role: 'supervisor', userId: 'sup-1' });

    const resultat = await service.corriger(
      superviseur,
      recue.id,
      { nom: 'Boutique Awa', prix: 600 },
      'Prix relevé au mauvais rayon',
    );

    expect(resultat.revision).toBe(2);
    expect(resultat.changements).toEqual({ prix: { avant: 500, apres: 600 } });
    expect(base.revisionsEnregistrees).toHaveLength(2);
  });

  it('conserve l\'état d\'origine après correction', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    const superviseur = contexte({ role: 'supervisor' });
    await service.corriger(superviseur, recue.id, { nom: 'Modifié', prix: 1 });

    const historique = await service.revisions(contexte(), recue.id);
    expect(historique[0]!.data).toEqual({ nom: 'Boutique Awa', prix: 500 });
    expect(historique[1]!.data).toEqual({ nom: 'Modifié', prix: 1 });
  });

  it('attribue et motive chaque correction', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    await service.corriger(
      contexte({ role: 'supervisor', userId: 'sup-9' }),
      recue.id,
      { nom: 'Corrigé', prix: 500 },
      'Erreur de saisie signalée par le chef de terrain',
    );

    const derniere = base.revisionsEnregistrees[1]!;
    expect(derniere.changedByUserId).toBe('sup-9');
    expect(derniere.reason).toBe('Erreur de saisie signalée par le chef de terrain');
  });

  it('ne crée aucune révision si rien ne change', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    await service.corriger(contexte({ role: 'supervisor' }), recue.id, {
      nom: 'Boutique Awa',
      prix: 500,
    });
    expect(base.revisionsEnregistrees).toHaveLength(1);
  });

  it('refuse la correction par un agent', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    await expect(
      service.corriger(contexte(), recue.id, { nom: 'Triché' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuse la correction par un membre révoqué', async () => {
    const recue = await service.recevoir(contexte(), entrante());
    await expect(
      service.corriger(contexte({ role: 'supervisor', revoque: true }), recue.id, {
        nom: 'Triché',
      }),
    ).rejects.toThrow();
  });
});

describe('visibilité', () => {
  beforeEach(async () => {
    await service.recevoir(contexte(), entrante());
    await service.recevoir(contexte({ userId: AUTRE_AGENT }), entrante());
  });

  it('un agent ne voit que ses propres soumissions', async () => {
    const vues = await service.lister(contexte());
    expect(vues).toHaveLength(1);
    expect(vues[0]!.collectedByUserId).toBe(AGENT);
  });

  it('un superviseur voit toute l\'organisation', async () => {
    const vues = await service.lister(contexte({ role: 'supervisor' }));
    expect(vues).toHaveLength(2);
  });

  it('personne ne voit les soumissions d\'une autre organisation', async () => {
    const vues = await service.lister(contexte({ organizationId: ORG_B, role: 'owner' }));
    expect(vues).toHaveLength(0);
  });

  it('rend introuvable l\'historique d\'une soumission étrangère', async () => {
    const id = base.soumissions[0]!.id;
    await expect(
      service.revisions(contexte({ organizationId: ORG_B, role: 'owner' }), id),
    ).rejects.toThrow(NotFoundException);
  });
});
