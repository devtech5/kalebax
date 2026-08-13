import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { FormulairesService } from './formulaires.service.js';
import { BasePrismaFormulaires } from './prisma-memoire-formulaires.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

let base: BasePrismaFormulaires;
let service: FormulairesService;

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

/** Formulaire minimal valide, avec une question. */
function documentValide(nomQuestion = 'nom') {
  return {
    schemaVersion: 1,
    title: { fr: 'Relevé' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children: [
      { id: `q_${nomQuestion}`, name: nomQuestion, type: 'text', label: { fr: 'Nom' } },
    ],
  };
}

async function projetEtFormulaire(ctx = contexte()) {
  const projet = await service.creerProjet(ctx, { name: 'Audit T3' });
  const formulaire = await service.creerFormulaire(ctx, projet.id, {
    name: 'Relevé',
    schema: documentValide(),
  });
  const version = base.formVersions.find((v) => v.formId === formulaire.id)!;
  return { projet, formulaire, version };
}

beforeEach(() => {
  base = new BasePrismaFormulaires();
  service = new FormulairesService(base.enServicePrisma());
});

describe('projets', () => {
  it('crée un projet dans l\'organisation du jeton', async () => {
    const projet = await service.creerProjet(contexte(), { name: 'Audit T3' });
    expect(projet.organizationId).toBe(ORG_A);
  });

  it('ne liste que les projets de son organisation', async () => {
    await service.creerProjet(contexte(), { name: 'Chez A' });
    await service.creerProjet(contexte({ organizationId: ORG_B }), { name: 'Chez B' });

    const vus = await service.listerProjets(contexte());
    expect(vus.map((p) => p.name)).toEqual(['Chez A']);
  });

  it('refuse la création à un agent', async () => {
    await expect(
      service.creerProjet(contexte({ role: 'agent' }), { name: 'Interdit' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuse la création à un membre révoqué', async () => {
    await expect(
      service.creerProjet(contexte({ revoque: true }), { name: 'Interdit' }),
    ).rejects.toThrow();
  });
});

describe('création de formulaire', () => {
  it('crée une première version en brouillon', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    expect(formulaire.currentVersionId).toBeNull();
    expect(version.versionNumber).toBe(1);
    expect(version.status).toBe('draft');
  });

  it('accepte un brouillon incomplet', async () => {
    // Un brouillon se construit par petites touches : refuser une sauvegarde
    // intermédiaire ferait perdre du travail.
    const projet = await service.creerProjet(contexte(), { name: 'Audit' });
    await expect(
      service.creerFormulaire(contexte(), projet.id, {
        name: 'Brouillon',
        schema: { schemaVersion: 1, children: [] },
      }),
    ).resolves.toBeDefined();
  });

  it('refuse un projet d\'une autre organisation', async () => {
    const projet = await service.creerProjet(contexte({ organizationId: ORG_B }), {
      name: 'Chez B',
    });
    await expect(
      service.creerFormulaire(contexte(), projet.id, { name: 'Vol' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('immuabilité des versions publiées', () => {
  it('laisse modifier un brouillon', async () => {
    const { version } = await projetEtFormulaire();
    await expect(
      service.modifierVersion(contexte(), version.id, documentValide('autre')),
    ).resolves.toBeDefined();
  });

  it('refuse toute modification après publication', async () => {
    // Y compris au propriétaire de l'organisation : corriger, c'est publier une
    // version suivante.
    const { version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    await expect(
      service.modifierVersion(contexte({ role: 'owner' }), version.id, documentValide()),
    ).rejects.toThrow(ConflictException);
  });

  it('refuse de republier une version déjà publiée', async () => {
    const { version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);
    await expect(service.publierVersion(contexte(), version.id)).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('publication', () => {
  it('valide le document avant de publier', async () => {
    // Une erreur découverte par un agent à 300 km du bureau est un échec
    // produit.
    const projet = await service.creerProjet(contexte(), { name: 'Audit' });
    const formulaire = await service.creerFormulaire(contexte(), projet.id, {
      name: 'Fautif',
      schema: {
        ...documentValide(),
        children: [
          {
            id: 'q1',
            name: 'a',
            type: 'text',
            label: { fr: 'A' },
            relevant: '${inexistante} = 1',
          },
        ],
      },
    });
    const version = base.formVersions.find((v) => v.formId === formulaire.id)!;

    await expect(service.publierVersion(contexte(), version.id)).rejects.toThrow(
      BadRequestException,
    );
    expect(base.formVersions[0]!.status).toBe('draft');
  });

  it('désigne la version publiée comme version courante', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    const resultat = await service.publierVersion(contexte(), version.id);

    expect(resultat.versionNumber).toBe(1);
    expect(resultat.breakingChange).toBe(false);
    expect(base.forms.find((f) => f.id === formulaire.id)!.currentVersionId).toBe(
      version.id,
    );
  });

  it('met l\'ancienne version en retrait sans la supprimer', async () => {
    // Les brouillons commencés sur l'ancienne version restent soumettables.
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    const v2 = await service.nouvelleVersion(contexte(), formulaire.id);
    await service.publierVersion(contexte(), v2.id);

    expect(base.formVersions.find((v) => v.id === version.id)!.status).toBe('retired');
    expect(base.formVersions).toHaveLength(2);
  });

  it('signale une rupture de compatibilité', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    const v2 = await service.nouvelleVersion(contexte(), formulaire.id);
    // Suppression de la seule question : rupture.
    await service.modifierVersion(contexte(), v2.id, {
      ...documentValide(),
      children: [],
    });

    const resultat = await service.publierVersion(contexte(), v2.id);
    expect(resultat.breakingChange).toBe(true);
    expect(resultat.comparaison?.ruptures.map((r) => r.code)).toContain(
      'question-supprimee',
    );
  });

  it('ne signale aucune rupture pour un ajout facultatif', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    const v2 = await service.nouvelleVersion(contexte(), formulaire.id);
    await service.modifierVersion(contexte(), v2.id, {
      ...documentValide(),
      children: [
        ...documentValide().children,
        { id: 'q_age', name: 'age', type: 'integer', label: { fr: 'Âge' } },
      ],
    });

    const resultat = await service.publierVersion(contexte(), v2.id);
    expect(resultat.breakingChange).toBe(false);
  });

  it('compte les soumissions déjà reçues sur la version précédente', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);
    base.submissions.push({ organizationId: ORG_A, formVersionId: version.id });

    const v2 = await service.nouvelleVersion(contexte(), formulaire.id);
    const resultat = await service.publierVersion(contexte(), v2.id);
    expect(resultat.soumissionsExistantes).toBe(1);
  });
});

describe('nouvelle version', () => {
  it('recopie le document de la version courante', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    const v2 = await service.nouvelleVersion(contexte(), formulaire.id);
    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.schema).toEqual(version.schema);
  });

  it('refuse un second brouillon simultané', async () => {
    const { formulaire } = await projetEtFormulaire();
    await expect(service.nouvelleVersion(contexte(), formulaire.id)).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('isolation multi-tenant', () => {
  it('refuse d\'atteindre une version d\'une autre organisation par son identifiant', async () => {
    // Y compris avec l'UUID exact : un 403 confirmerait son existence.
    const { version } = await projetEtFormulaire();
    await expect(
      service.publierVersion(contexte({ organizationId: ORG_B, role: 'owner' }), version.id),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuse de lire le document courant d\'une autre organisation', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    await expect(
      service.documentCourant(contexte({ organizationId: ORG_B }), formulaire.id),
    ).rejects.toThrow(NotFoundException);
  });

  it('ne liste pas les versions d\'un formulaire étranger', async () => {
    const { formulaire } = await projetEtFormulaire();
    await expect(
      service.listerVersions(contexte({ organizationId: ORG_B }), formulaire.id),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('document courant', () => {
  it('rend le document de la version publiée', async () => {
    const { formulaire, version } = await projetEtFormulaire();
    await service.publierVersion(contexte(), version.id);

    const document = await service.documentCourant(contexte(), formulaire.id);
    expect(document.children).toHaveLength(1);
  });

  it('refuse tant qu\'aucune version n\'est publiée', async () => {
    const { formulaire } = await projetEtFormulaire();
    await expect(service.documentCourant(contexte(), formulaire.id)).rejects.toThrow(
      NotFoundException,
    );
  });
});
