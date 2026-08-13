import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatasetsService, LIMITES_DATASET, type EntreeImport } from './datasets.service.js';
import { BasePrismaDatasets } from './prisma-memoire-datasets.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

let base: BasePrismaDatasets;
let service: DatasetsService;
let jeuId: string;

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

const ABIDJAN = { value: 'pv-1', label: 'Boutique du marché', attributes: { region: 'abidjan' } };
const BOUAKE = { value: 'pv-2', label: 'Alimentation Awa', attributes: { region: 'bouake' } };

beforeEach(async () => {
  base = new BasePrismaDatasets();
  service = new DatasetsService(base.enServicePrisma());
  const jeu = await service.creer(contexte(), {
    name: 'points_vente',
    label: 'Points de vente',
  });
  jeuId = jeu.id;
});

describe('création', () => {
  it('crée un jeu dans l\'organisation du jeton', async () => {
    expect(base.jeux[0]?.organizationId).toBe(ORG_A);
    expect(base.jeux[0]?.version).toBe(1);
  });

  it('refuse un nom technique mal formé', async () => {
    for (const nom of ['Points Vente', '1points', 'points-vente', 'pointsVente']) {
      await expect(
        service.creer(contexte(), { name: nom, label: 'X' }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('refuse la création à un agent', async () => {
    await expect(
      service.creer(contexte({ role: 'agent' }), { name: 'interdit', label: 'X' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('import', () => {
  it('crée les entrées et incrémente la version', async () => {
    const rapport = await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);

    expect(rapport.version).toBe(2);
    expect(rapport.ajoutees).toBe(2);
    expect(rapport.versionIncrementee).toBe(true);
    expect(base.jeux[0]?.entryCount).toBe(2);
  });

  it('n\'incrémente pas la version quand rien ne change', async () => {
    // Sinon un rafraîchissement quotidien automatique ferait retélécharger un
    // delta vide à tous les appareils, chaque jour.
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    const second = await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);

    expect(second.versionIncrementee).toBe(false);
    expect(second.version).toBe(2);
    expect(second.inchangees).toBe(2);
  });

  it('ne touche pas les entrées identiques', async () => {
    // Les réécrire produirait un delta complet à chaque import.
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    await service.importer(contexte(), jeuId, [
      ABIDJAN,
      { ...BOUAKE, label: 'Alimentation Awa et fils' },
    ]);

    const inchangee = base.entrees.find((e) => e.value === 'pv-1');
    expect(inchangee?.version).toBe(2);
    const modifiee = base.entrees.find((e) => e.value === 'pv-2');
    expect(modifiee?.version).toBe(3);
  });

  it('retire logiquement une entrée absente du nouvel import', async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    const rapport = await service.importer(contexte(), jeuId, [ABIDJAN]);

    expect(rapport.retirees).toBe(1);
    const retiree = base.entrees.find((e) => e.value === 'pv-2');
    expect(retiree).toBeDefined();
    expect(retiree?.deletedAtVersion).toBe(3);
  });

  it('garde une entrée retirée lisible', async () => {
    // La boutique choisie il y a trois mois a fermé, son libellé reste lisible.
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    await service.importer(contexte(), jeuId, [ABIDJAN]);

    expect(base.entrees.find((e) => e.value === 'pv-2')?.label).toBe('Alimentation Awa');
  });

  it('réutilise la ligne d\'une entrée réintroduite', async () => {
    // En créer une seconde casserait l'unicité et l'historique.
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    await service.importer(contexte(), jeuId, [ABIDJAN]);
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);

    const lignes = base.entrees.filter((e) => e.value === 'pv-2');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.deletedAtVersion).toBeNull();
  });

  it('détecte un changement d\'attributs', async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN]);
    const rapport = await service.importer(contexte(), jeuId, [
      { ...ABIDJAN, attributes: { region: 'abidjan', quartier: 'cocody' } },
    ]);
    expect(rapport.modifiees).toBe(1);
  });

  it('refuse deux fois la même valeur', async () => {
    await expect(
      service.importer(contexte(), jeuId, [ABIDJAN, { ...ABIDJAN, label: 'Doublon' }]),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse un attribut qui n\'est pas une valeur simple', async () => {
    // Le filtrage en cascade ne sait pas parcourir une structure imbriquée.
    await expect(
      service.importer(contexte(), jeuId, [
        { value: 'pv-1', label: 'X', attributes: { zone: { nom: 'nord' } } as never },
      ]),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse une valeur trop longue', async () => {
    await expect(
      service.importer(contexte(), jeuId, [
        { value: 'x'.repeat(LIMITES_DATASET.longueurValeur + 1), label: 'X' },
      ]),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse un import d\'une autre organisation', async () => {
    await expect(
      service.importer(contexte({ organizationId: ORG_B, role: 'owner' }), jeuId, [ABIDJAN]),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuse un import par un membre révoqué', async () => {
    await expect(
      service.importer(contexte({ revoque: true }), jeuId, [ABIDJAN]),
    ).rejects.toThrow();
  });
});

describe('différentiel', () => {
  beforeEach(async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
  });

  it('ne renvoie rien à un appareil à jour', async () => {
    expect(await service.delta(contexte(), { points_vente: 2 })).toEqual([]);
  });

  it('envoie l\'intégral à un appareil qui ne détient rien', async () => {
    const deltas = await service.delta(contexte(), {});
    expect(deltas[0]?.mode).toBe('complet');
    expect(deltas[0]?.ajoutees).toHaveLength(2);
    expect(deltas[0]?.version).toBe(2);
  });

  it('envoie le delta d\'un appareil légèrement en retard', async () => {
    // Un ajout sur un jeu qui en compte déjà beaucoup reste sous le seuil.
    const grosJeu: EntreeImport[] = Array.from({ length: 20 }, (_, i) => ({
      value: `pv-${i}`,
      label: `Boutique ${i}`,
    }));
    await service.importer(contexte(), jeuId, grosJeu);
    await service.importer(contexte(), jeuId, [...grosJeu, { value: 'pv-99', label: 'Nouvelle' }]);

    const deltas = await service.delta(contexte(), { points_vente: 3 });
    expect(deltas[0]?.mode).toBe('delta');
    expect(deltas[0]?.ajoutees.map((e) => e.value)).toEqual(['pv-99']);
  });

  it('signale les entrées retirées', async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN]);
    const deltas = await service.delta(contexte(), { points_vente: 2 });

    expect(deltas[0]?.retirees).toEqual(['pv-2']);
  });

  it('bascule en intégral quand le delta approche le jeu entier', async () => {
    // Un appareil qui revient après six semaines recevrait sinon un
    // différentiel plus lourd que l'original.
    const remplacement: EntreeImport[] = Array.from({ length: 10 }, (_, i) => ({
      value: `nouveau-${i}`,
      label: `Nouveau ${i}`,
    }));
    await service.importer(contexte(), jeuId, remplacement);

    const deltas = await service.delta(contexte(), { points_vente: 2 });
    expect(deltas[0]?.mode).toBe('complet');
  });

  it('ne renvoie que les entrées vivantes en mode intégral', async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN]);
    const deltas = await service.delta(contexte(), {});

    expect(deltas[0]?.mode).toBe('complet');
    expect(deltas[0]?.ajoutees.map((e) => e.value)).toEqual(['pv-1']);
  });

  it('ne voit pas les jeux d\'une autre organisation', async () => {
    expect(await service.delta(contexte({ organizationId: ORG_B, role: 'owner' }), {})).toEqual(
      [],
    );
  });
});

describe('valeurs autorisées', () => {
  beforeEach(async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
  });

  it('rend les valeurs d\'un jeu par son nom', async () => {
    const valeurs = await service.valeursAutorisees(contexte(), ['points_vente']);
    expect([...(valeurs['points_vente'] ?? [])].sort()).toEqual(['pv-1', 'pv-2']);
  });

  it('inclut les valeurs retirées', async () => {
    // L'agent les a choisies alors qu'elles existaient : les refuser lui
    // reprocherait le temps qui passe.
    await service.importer(contexte(), jeuId, [ABIDJAN]);
    const valeurs = await service.valeursAutorisees(contexte(), ['points_vente']);
    expect(valeurs['points_vente']?.has('pv-2')).toBe(true);
  });

  it('ignore un jeu inconnu', async () => {
    expect(await service.valeursAutorisees(contexte(), ['inexistant'])).toEqual({});
  });

  it('ne rend rien pour une liste vide', async () => {
    expect(await service.valeursAutorisees(contexte(), [])).toEqual({});
  });

  it('ne traverse pas les organisations', async () => {
    const valeurs = await service.valeursAutorisees(
      contexte({ organizationId: ORG_B, role: 'owner' }),
      ['points_vente'],
    );
    expect(valeurs).toEqual({});
  });
});

describe('consultation', () => {
  it('ne liste que les entrées vivantes', async () => {
    await service.importer(contexte(), jeuId, [ABIDJAN, BOUAKE]);
    await service.importer(contexte(), jeuId, [ABIDJAN]);

    const entrees = await service.listerEntrees(contexte(), jeuId);
    expect(entrees.map((e) => e.value)).toEqual(['pv-1']);
  });

  it('refuse un jeu d\'une autre organisation', async () => {
    await expect(
      service.listerEntrees(contexte({ organizationId: ORG_B, role: 'owner' }), jeuId),
    ).rejects.toThrow(NotFoundException);
  });
});
