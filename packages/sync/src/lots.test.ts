import type { SoumissionLocale } from '@kalebax/storage';
import { describe, expect, it } from 'vitest';
import { decouperEnLots, estimerOctets } from './lots.js';
import { delaiTentative, PALIERS_SECONDES, prochaineTentative, VARIATION } from './temporisation.js';

function soumission(id: string, tailleData = 10): SoumissionLocale {
  return {
    id,
    formVersionId: 'v1',
    projectId: 'p1',
    data: { texte: 'x'.repeat(tailleData) },
    etat: 'en_attente',
    startedAt: '2026-08-13T09:00:00.000Z',
    completedAt: '2026-08-13T09:10:00.000Z',
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
  };
}

describe('découpage en lots', () => {
  it('ne fait aucun lot pour une file vide', () => {
    expect(decouperEnLots([])).toEqual([]);
  });

  it('respecte la borne de nombre', () => {
    const file = Array.from({ length: 60 }, (_, i) => soumission(`s${i}`));
    const lots = decouperEnLots(file, 25, 1_000_000);
    expect(lots.map((l) => l.soumissions.length)).toEqual([25, 25, 10]);
  });

  it('respecte la borne d\'octets', () => {
    const file = Array.from({ length: 10 }, (_, i) => soumission(`s${i}`, 200));
    const lots = decouperEnLots(file, 25, 600);
    expect(lots.length).toBeGreaterThan(1);
    for (const lot of lots) {
      // Un lot d'un seul élément peut dépasser : voir le test suivant.
      if (lot.soumissions.length > 1) expect(lot.octetsEstimes).toBeLessThanOrEqual(600);
    }
  });

  it('laisse partir seule une soumission trop grosse', () => {
    // La refuser la bloquerait pour toujours, et une donnée de terrain ne se
    // jette pas parce qu'elle est encombrante.
    const file = [soumission('petite', 10), soumission('enorme', 5000), soumission('autre', 10)];
    const lots = decouperEnLots(file, 25, 1000);

    const lotEnorme = lots.find((l) => l.soumissions.some((s) => s.id === 'enorme'));
    expect(lotEnorme?.soumissions).toHaveLength(1);
    expect(lots.flatMap((l) => l.soumissions.map((s) => s.id))).toEqual([
      'petite',
      'enorme',
      'autre',
    ]);
  });

  it('conserve l\'ordre d\'arrivée', () => {
    const file = Array.from({ length: 30 }, (_, i) => soumission(`s${String(i).padStart(2, '0')}`));
    const lots = decouperEnLots(file, 10, 1_000_000);
    expect(lots.flatMap((l) => l.soumissions.map((s) => s.id))).toEqual(
      file.map((s) => s.id),
    );
  });

  it('ne fait pas circuler les champs purement locaux', () => {
    const [lot] = decouperEnLots([soumission('s1')]);
    const sortante = lot?.sortantes[0] as unknown as Record<string, unknown>;
    expect(sortante).not.toHaveProperty('etat');
    expect(sortante).not.toHaveProperty('nombreTentatives');
    expect(sortante).not.toHaveProperty('prochaineTentativeA');
    expect(sortante['id']).toBe('s1');
  });

  it('estime une taille croissante avec le contenu', () => {
    expect(estimerOctets(soumission('s1', 1000))).toBeGreaterThan(
      estimerOctets(soumission('s1', 10)),
    );
  });
});

describe('temporisation', () => {
  it('suit les paliers', () => {
    for (const [index, secondes] of PALIERS_SECONDES.entries()) {
      // hasard = 0,5 annule la variation.
      expect(delaiTentative(index, () => 0.5)).toBe(secondes * 1000);
    }
  });

  it('plafonne à une heure', () => {
    expect(delaiTentative(99, () => 0.5)).toBe(3_600_000);
  });

  it('applique une variation d\'au plus ±20 %', () => {
    // Sans elle, cinquante agents qui retrouvent le réseau à la fin d'une
    // réunion frappent le serveur au même instant.
    const base = PALIERS_SECONDES[0]! * 1000;
    expect(delaiTentative(0, () => 0)).toBe(Math.round(base * (1 - VARIATION)));
    expect(delaiTentative(0, () => 0.999999)).toBeCloseTo(base * (1 + VARIATION), -1);
  });

  it('étale réellement les tentatives', () => {
    const delais = new Set(
      Array.from({ length: 200 }, () => delaiTentative(0)),
    );
    expect(delais.size).toBeGreaterThan(50);
  });

  it('traite un compteur négatif comme un premier essai', () => {
    expect(delaiTentative(-3, () => 0.5)).toBe(PALIERS_SECONDES[0]! * 1000);
  });

  it('rend une date future', () => {
    const maintenant = new Date('2026-08-13T09:00:00.000Z');
    const suivante = prochaineTentative(0, maintenant, () => 0.5);
    expect(suivante.getTime() - maintenant.getTime()).toBe(5000);
  });
});
