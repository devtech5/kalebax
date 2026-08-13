import { describe, expect, it } from 'vitest';
import { verifierConformite } from '../conformite/index.js';
import { MagasinSql } from './magasin-sql.js';
import { PiloteSqlNode } from './pilote-node.js';
import type { Chiffreur } from './pilote.js';

// L'adaptateur SQL passe la suite de conformité sur du vrai SQLite, pas sur une
// imitation en mémoire : c'est le même moteur que sur mobile et sur desktop.
verifierConformite({
  nom: 'SQL (node:sqlite)',
  creer: async () => new MagasinSql(new PiloteSqlNode()),
});

/** Chiffrement factice mais réel : la valeur stockée n'est pas la valeur lue. */
const CHIFFREUR_TEST: Chiffreur = {
  chiffrer: (clair) => `chiffre:${Buffer.from(clair).toString('base64')}`,
  dechiffrer: (chiffre) =>
    Buffer.from(chiffre.replace(/^chiffre:/, ''), 'base64').toString('utf8'),
};

verifierConformite({
  nom: 'SQL chiffré',
  creer: async () => new MagasinSql(new PiloteSqlNode(), CHIFFREUR_TEST),
});

describe('chiffrement au repos', () => {
  it('ne laisse pas les réponses en clair dans la base', async () => {
    // Un téléphone de terrain se perd, et il contient des données personnelles
    // d'enquêtés.
    const pilote = new PiloteSqlNode();
    const magasin = new MagasinSql(pilote, CHIFFREUR_TEST);
    await magasin.ouvrir();

    await magasin.enregistrerBrouillon({
      id: 's1',
      formVersionId: 'v1',
      projectId: 'p1',
      data: { nom: 'Kouassi', revenu_mensuel: 85000 },
      etat: 'brouillon',
      startedAt: '2026-08-13T09:00:00.000Z',
      completedAt: null,
      deviceId: null,
      appVersion: null,
      startLatitude: null,
      startLongitude: null,
      startAccuracy: null,
      startGeopointStatus: null,
      statutServeur: null,
      codeEchec: null,
      messageEchec: null,
      nombreTentatives: 0,
      prochaineTentativeA: null,
      createdAt: '2026-08-13T09:00:00.000Z',
      updatedAt: '2026-08-13T09:00:00.000Z',
    });

    const brut = await pilote.interroger<{ data: string }>(
      'SELECT data FROM soumissions WHERE id = ?',
      ['s1'],
    );
    expect(brut[0]?.data).not.toContain('Kouassi');
    expect(brut[0]?.data).not.toContain('85000');

    // Mais la lecture métier reste transparente.
    expect((await magasin.lireSoumission('s1'))?.data).toEqual({
      nom: 'Kouassi',
      revenu_mensuel: 85000,
    });

    await magasin.fermer();
  });

  it('laisse les états en clair, pour pouvoir les interroger', async () => {
    // On n'indexe pas du chiffré : « lister les soumissions en attente » doit
    // rester une requête, pas un déchiffrement de toute la base.
    const pilote = new PiloteSqlNode();
    const magasin = new MagasinSql(pilote, CHIFFREUR_TEST);
    await magasin.ouvrir();

    const lignes = await pilote.interroger<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    );
    expect(lignes.map((l) => l.name)).toContain('idx_soumissions_etat');

    await magasin.fermer();
  });
});

describe('migrations', () => {
  it('n\'applique une migration qu\'une fois', async () => {
    const pilote = new PiloteSqlNode();
    const magasin = new MagasinSql(pilote);

    await magasin.ouvrir();
    await magasin.ouvrir();
    await magasin.ouvrir();

    const appliquees = await pilote.interroger<{ version: number }>(
      'SELECT version FROM migrations',
    );
    expect(appliquees).toHaveLength(1);
    await magasin.fermer();
  });
});

describe('atomicité', () => {
  it('n\'écrit rien si un média échoue', async () => {
    // Une soumission enregistrée sans ses médias serait envoyée sans preuve,
    // et personne ne saurait qu'il en manque.
    const pilote = new PiloteSqlNode();
    const magasin = new MagasinSql(pilote);
    await magasin.ouvrir();

    const base = {
      id: 's1',
      formVersionId: 'v1',
      projectId: 'p1',
      data: {},
      startedAt: '2026-08-13T09:00:00.000Z',
      completedAt: '2026-08-13T09:10:00.000Z',
      deviceId: null,
      appVersion: null,
      startLatitude: null,
      startLongitude: null,
      startAccuracy: null,
      startGeopointStatus: null,
    };

    await expect(
      magasin.finaliserSoumission({
        soumission: base,
        medias: [
          {
            id: 'm1',
            submissionId: 's1',
            questionName: 'photos',
            kind: 'photo',
            cheminFichier: '/media/1.jpg',
            mimeType: 'image/jpeg',
            // sizeBytes manquant : l'insertion du média échoue.
            sizeBytes: undefined as unknown as number,
            checksum: 'a'.repeat(64),
            capturedAt: null,
            latitude: null,
            longitude: null,
          },
        ],
      }),
    ).rejects.toThrow();

    expect(await magasin.lireSoumission('s1')).toBeNull();
    await magasin.fermer();
  });
});
