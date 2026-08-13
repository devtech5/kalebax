import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { BasePrismaSync } from './prisma-memoire-sync.js';
import { StockageMediasMemoire } from './stockage-medias.port.js';
import { SyncService } from './sync.service.js';
import { SoumissionsService, type SoumissionEntrante } from '../soumissions/soumissions.service.js';
import type { DatasetsService } from '../datasets/datasets.service.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const VERSION = randomUUID();
const AGENT = randomUUID();

let base: BasePrismaSync;
let stockage: StockageMediasMemoire;
let service: SyncService;
let datasets: DatasetsService;
let projetId: string;

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
  children: [{ id: 'q_nom', name: 'nom', type: 'text', label: { fr: 'Nom' } }],
};

function entrante(extra: Partial<SoumissionEntrante> = {}): SoumissionEntrante {
  return {
    id: randomUUID(),
    formVersionId: VERSION,
    data: { nom: 'Boutique Awa' },
    startedAt: '2026-08-13T09:00:00.000Z',
    completedAt: '2026-08-13T09:10:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  base = new BasePrismaSync();
  stockage = new StockageMediasMemoire();
  datasets = {
    valeursAutorisees: async () => ({}),
    delta: async () => [],
  } as unknown as DatasetsService;

  service = new SyncService(
    base.enServicePrisma(),
    new SoumissionsService(base.enServicePrisma(), datasets),
    datasets,
    stockage,
  );

  projetId = base.ajouterProjet(ORG_A);
  base.versions.push({
    id: VERSION,
    organizationId: ORG_A,
    status: 'published',
    schema: DOCUMENT,
    projectId: projetId,
  });
});

describe('réception d\'un lot', () => {
  it('rend un résultat par élément', async () => {
    const lot = [entrante(), entrante(), entrante()];
    const resultats = await service.recevoirLot(contexte(), lot);

    expect(resultats).toHaveLength(3);
    expect(resultats.every((r) => r.etat === 'recue')).toBe(true);
  });

  it('distingue une soumission déjà reçue', async () => {
    const soumission = entrante();
    await service.recevoirLot(contexte(), [soumission]);
    const second = await service.recevoirLot(contexte(), [soumission]);

    expect(second[0]?.etat).toBe('deja');
    expect(base.soumissions).toHaveLength(1);
  });

  it('ne fait pas tout ou rien', async () => {
    // Un tout-ou-rien ferait rejouer indéfiniment un lot entier à cause d'une
    // seule soumission problématique.
    const bonne = entrante();
    const mauvaise = entrante({ formVersionId: randomUUID() });

    const resultats = await service.recevoirLot(contexte(), [bonne, mauvaise, entrante()]);

    expect(resultats.map((r) => r.etat)).toEqual(['recue', 'refusee', 'recue']);
    expect(resultats[1]?.code).toBe('version-inconnue');
    expect(base.soumissions).toHaveLength(2);
  });

  it('refuse une version non publiée sans bloquer le lot', async () => {
    base.versions[0]!.status = 'draft';
    const resultats = await service.recevoirLot(contexte(), [entrante()]);
    expect(resultats[0]?.etat).toBe('refusee');
    expect(resultats[0]?.code).toBe('version-non-publiee');
  });

  it('remonte le statut de validation', async () => {
    const resultats = await service.recevoirLot(contexte(), [entrante()]);
    expect(resultats[0]?.status).toBe('received');
  });

  it('laisse un membre révoqué envoyer ce qu\'il a collecté', async () => {
    const resultats = await service.recevoirLot(contexte({ revoque: true }), [entrante()]);
    expect(resultats[0]?.etat).toBe('recue');
  });
});

describe('envoi de média par morceaux', () => {
  const MEDIA = randomUUID();

  async function preparerSoumission(): Promise<string> {
    const soumission = entrante();
    await service.recevoirLot(contexte(), [soumission]);
    return soumission.id;
  }

  function annonce(submissionId: string, contenu: Buffer) {
    return {
      submissionId,
      questionName: 'photos',
      kind: 'photo' as const,
      mimeType: 'image/jpeg',
      sizeBytes: contenu.byteLength,
      checksum: createHash('sha256').update(contenu).digest('hex'),
    };
  }

  it('annonce zéro octet pour un média inconnu', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);

    const { octetsRecus } = await service.initierMedia(
      contexte(),
      MEDIA,
      annonce(submissionId, contenu),
    );
    expect(octetsRecus).toBe(0);
  });

  it('accepte et scelle un média complet', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);

    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));
    await service.recevoirMorceau(contexte(), MEDIA, 0, contenu);
    await service.completerMedia(contexte(), MEDIA);

    expect(base.attachments[0]?.uploadedAt).not.toBeNull();
  });

  it('reprend là où le serveur s\'est arrêté', async () => {
    // C'est le serveur qui fait foi : un compteur local divergerait au premier
    // redémarrage brutal.
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);

    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));
    await service.recevoirMorceau(contexte(), MEDIA, 0, contenu.subarray(0, 400));

    const reprise = await service.initierMedia(
      contexte(),
      MEDIA,
      annonce(submissionId, contenu),
    );
    expect(reprise.octetsRecus).toBe(400);

    await service.recevoirMorceau(contexte(), MEDIA, 400, contenu.subarray(400));
    await service.completerMedia(contexte(), MEDIA);
    expect(base.attachments[0]?.uploadedAt).not.toBeNull();
  });

  it('indique où reprendre plutôt que de refuser sèchement', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);
    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));
    await service.recevoirMorceau(contexte(), MEDIA, 0, contenu.subarray(0, 400));

    // L'appareil se croit à 800.
    await expect(
      service.recevoirMorceau(contexte(), MEDIA, 800, contenu.subarray(800)),
    ).rejects.toThrow(ConflictException);
  });

  it('refuse un morceau qui dépasse la taille annoncée', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(100, 7);
    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));

    await expect(
      service.recevoirMorceau(contexte(), MEDIA, 0, Buffer.alloc(500, 7)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse un fichier arrivé abîmé et le jette', async () => {
    // Un média corrompu vaut moins que pas de média : il fait croire à une
    // preuve.
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);
    const declare = annonce(submissionId, contenu);

    await service.initierMedia(contexte(), MEDIA, declare);
    // On envoie autre chose que ce qui a été annoncé.
    await service.recevoirMorceau(contexte(), MEDIA, 0, Buffer.alloc(1000, 9));

    await expect(service.completerMedia(contexte(), MEDIA)).rejects.toThrow(
      BadRequestException,
    );
    expect(base.attachments[0]?.uploadedAt).toBeNull();
    expect(await stockage.taille(base.attachments[0]!.storageKey)).toBe(0);
  });

  it('refuse de sceller un fichier incomplet', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);
    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));
    await service.recevoirMorceau(contexte(), MEDIA, 0, contenu.subarray(0, 400));

    await expect(service.completerMedia(contexte(), MEDIA)).rejects.toThrow(
      ConflictException,
    );
  });

  it('accepte un second scellement sans rien changer', async () => {
    const submissionId = await preparerSoumission();
    const contenu = Buffer.alloc(1000, 7);
    await service.initierMedia(contexte(), MEDIA, annonce(submissionId, contenu));
    await service.recevoirMorceau(contexte(), MEDIA, 0, contenu);
    await service.completerMedia(contexte(), MEDIA);

    const premierScellement = base.attachments[0]?.uploadedAt;
    await service.completerMedia(contexte(), MEDIA);
    expect(base.attachments[0]?.uploadedAt).toBe(premierScellement);
  });

  it('range les médias par organisation', async () => {
    const submissionId = await preparerSoumission();
    await service.initierMedia(
      contexte(),
      MEDIA,
      annonce(submissionId, Buffer.alloc(10, 1)),
    );
    expect(base.attachments[0]?.storageKey.startsWith(`${ORG_A}/`)).toBe(true);
  });

  it('refuse un média rattaché à une soumission d\'une autre organisation', async () => {
    const submissionId = await preparerSoumission();
    await expect(
      service.initierMedia(
        contexte({ organizationId: ORG_B, role: 'owner' }),
        MEDIA,
        annonce(submissionId, Buffer.alloc(10, 1)),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('paquet descendant', () => {
  beforeEach(() => {
    base.formVersionsCompletes.push(
      {
        id: VERSION,
        organizationId: ORG_A,
        formId: 'form-1',
        versionNumber: 2,
        status: 'published',
        schema: DOCUMENT,
        projectId: projetId,
        formName: 'Relevé',
      },
      {
        id: 'version-ancienne',
        organizationId: ORG_A,
        formId: 'form-1',
        versionNumber: 1,
        status: 'retired',
        schema: DOCUMENT,
        projectId: projetId,
        formName: 'Relevé',
      },
    );
  });

  it('renvoie les versions publiées et retirées', async () => {
    // Une version retirée reste téléchargeable : des brouillons peuvent s'y
    // rattacher.
    const paquet = await service.paquet(contexte(), projetId, []);
    expect(paquet.versions.map((v) => v.id).sort()).toEqual(
      [VERSION, 'version-ancienne'].sort(),
    );
  });

  it('ne renvoie que ce qui manque', async () => {
    // Retélécharger l'ensemble à chaque synchronisation serait inacceptable sur
    // un réseau facturé au mégaoctet.
    const paquet = await service.paquet(contexte(), projetId, [VERSION]);
    expect(paquet.versions.map((v) => v.id)).toEqual(['version-ancienne']);
  });

  it('signale ce que l\'appareil peut oublier', async () => {
    const paquet = await service.paquet(contexte(), projetId, ['version-disparue']);
    expect(paquet.versionsObsoletes).toEqual(['version-disparue']);
  });

  it('ne descend jamais un brouillon', async () => {
    base.formVersionsCompletes.push({
      id: 'version-brouillon',
      organizationId: ORG_A,
      formId: 'form-2',
      versionNumber: 1,
      status: 'draft',
      schema: DOCUMENT,
      projectId: projetId,
      formName: 'En cours',
    });

    const paquet = await service.paquet(contexte(), projetId, []);
    expect(paquet.versions.map((v) => v.id)).not.toContain('version-brouillon');
  });

  it('refuse le paquet à un membre révoqué', async () => {
    // Il envoie ce qu'il a collecté, il ne reçoit plus de mission.
    await expect(
      service.paquet(contexte({ revoque: true }), projetId, []),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuse un projet d\'une autre organisation', async () => {
    await expect(
      service.paquet(contexte({ organizationId: ORG_B, role: 'owner' }), projetId, []),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('diagnostic de terrain', () => {
  it('distingue ce que le serveur détient de ce qu\'il ignore', async () => {
    // Quand un agent affirme avoir tout envoyé et que le superviseur ne voit
    // rien, il faut pouvoir trancher depuis l'appareil.
    const envoyee = entrante();
    await service.recevoirLot(contexte(), [envoyee]);
    const jamaisPartie = randomUUID();

    const etat = await service.etat(contexte(), [envoyee.id, jamaisPartie]);

    expect(etat.connues.map((s) => s.id)).toEqual([envoyee.id]);
    expect(etat.inconnues).toEqual([jamaisPartie]);
  });

  it('ne révèle pas les soumissions d\'une autre organisation', async () => {
    const envoyee = entrante();
    await service.recevoirLot(contexte(), [envoyee]);

    const etat = await service.etat(
      contexte({ organizationId: ORG_B, role: 'owner' }),
      [envoyee.id],
    );
    expect(etat.connues).toHaveLength(0);
    expect(etat.inconnues).toEqual([envoyee.id]);
  });

  it('accepte une liste vide', async () => {
    expect(await service.etat(contexte(), [])).toEqual({ connues: [], inconnues: [] });
  });
});
