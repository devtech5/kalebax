import { describe, expect, it } from 'vitest';
import { validerDocument } from './index.js';
import type { DocumentFormulaire } from './types.js';
import { comparerVersions } from './versionnage.js';

function doc(children: unknown[]): DocumentFormulaire {
  const resultat = validerDocument({
    schemaVersion: 1,
    title: { fr: 'Test' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children,
  });
  if (!resultat.ok) {
    throw new Error(resultat.anomalies.map((a) => a.message).join(' / '));
  }
  return resultat.document;
}

function q(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, type: 'text', label: { fr: name }, ...extra };
}

function codes(avant: DocumentFormulaire, apres: DocumentFormulaire): string[] {
  return comparerVersions(avant, apres).changements.map((c) => c.code);
}

function rupture(avant: DocumentFormulaire, apres: DocumentFormulaire): boolean {
  return comparerVersions(avant, apres).breakingChange;
}

describe('changements compatibles', () => {
  it('ne signale rien entre deux versions identiques', () => {
    const version = doc([q('q1', 'nom')]);
    const rapport = comparerVersions(version, version);
    expect(rapport.changements).toHaveLength(0);
    expect(rapport.breakingChange).toBe(false);
  });

  it('accepte l\'ajout d\'une question facultative', () => {
    const avant = doc([q('q1', 'nom')]);
    const apres = doc([q('q1', 'nom'), q('q2', 'prenom')]);
    expect(rupture(avant, apres)).toBe(false);
    expect(codes(avant, apres)).toContain('question-ajoutee');
  });

  it('accepte une modification de libellé, d\'aide et d\'apparence', () => {
    const avant = doc([q('q1', 'nom')]);
    const apres = doc([
      q('q1', 'nom', {
        label: { fr: 'Nom complet' },
        hint: { fr: 'Tel qu\'inscrit sur la pièce d\'identité' },
        appearance: 'multiline',
      }),
    ]);
    expect(rupture(avant, apres)).toBe(false);
    expect(codes(avant, apres)).toEqual(
      expect.arrayContaining(['libelle-modifie', 'aide-modifiee', 'apparence-modifiee']),
    );
  });

  it('accepte l\'ajout d\'une option', () => {
    const liste = (options: unknown[]) =>
      doc([
        q('q1', 'region', {
          type: 'select_one',
          optionsSource: { kind: 'inline' },
          options,
        }),
      ]);
    const avant = liste([{ value: 'abidjan', label: { fr: 'Abidjan' } }]);
    const apres = liste([
      { value: 'abidjan', label: { fr: 'Abidjan' } },
      { value: 'bouake', label: { fr: 'Bouaké' } },
    ]);
    expect(rupture(avant, apres)).toBe(false);
    expect(codes(avant, apres)).toContain('option-ajoutee');
  });

  it('accepte le retrait d\'une contrainte et d\'une obligation', () => {
    const avant = doc([q('q1', 'age', { type: 'integer', required: true, constraint: '. > 18' })]);
    const apres = doc([q('q1', 'age', { type: 'integer' })]);
    expect(rupture(avant, apres)).toBe(false);
    expect(codes(avant, apres)).toEqual(
      expect.arrayContaining(['devenue-facultative', 'contrainte-supprimee']),
    );
  });
});

describe('changements incompatibles', () => {
  it('signale la suppression d\'une question', () => {
    const avant = doc([q('q1', 'nom'), q('q2', 'prenom')]);
    const apres = doc([q('q1', 'nom')]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('question-supprimee');
  });

  it('signale un changement de type', () => {
    const avant = doc([q('q1', 'age')]);
    const apres = doc([q('q1', 'age', { type: 'integer' })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('type-modifie');
  });

  it('signale un renommage', () => {
    // L'identifiant technique est stable : c'est ce qui distingue un renommage
    // d'une suppression suivie d'un ajout.
    const label = { fr: 'Nom' };
    const avant = doc([q('q1', 'nom', { label })]);
    const apres = doc([q('q1', 'nom_complet', { label })]);
    const rapport = comparerVersions(avant, apres);
    expect(rapport.breakingChange).toBe(true);
    expect(rapport.changements.map((c) => c.code)).toEqual(['nom-modifie']);
  });

  it('signale le passage en obligatoire', () => {
    const avant = doc([q('q1', 'nom')]);
    const apres = doc([q('q1', 'nom', { required: true })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('devenue-obligatoire');
  });

  it('signale une nouvelle question obligatoire', () => {
    const avant = doc([q('q1', 'nom')]);
    const apres = doc([q('q1', 'nom'), q('q2', 'prenom', { required: true })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('question-obligatoire-ajoutee');
  });

  it('traite toute modification de contrainte comme un durcissement', () => {
    // Décider laquelle de deux expressions est la plus permissive est
    // indécidable : on ne prétend pas savoir.
    const avant = doc([q('q1', 'age', { type: 'integer', constraint: '. > 0' })]);
    const apres = doc([q('q1', 'age', { type: 'integer', constraint: '. > 0 and . < 120' })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('contrainte-modifiee');
  });

  it('signale la suppression d\'une option', () => {
    const liste = (options: unknown[]) =>
      doc([
        q('q1', 'region', { type: 'select_one', optionsSource: { kind: 'inline' }, options }),
      ]);
    const avant = liste([
      { value: 'abidjan', label: { fr: 'Abidjan' } },
      { value: 'bouake', label: { fr: 'Bouaké' } },
    ]);
    const apres = liste([{ value: 'abidjan', label: { fr: 'Abidjan' } }]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('option-supprimee');
  });

  it('signale un abaissement de plafond de pièces jointes', () => {
    const avant = doc([q('q1', 'photos', { type: 'photo', maxCount: 5 })]);
    const apres = doc([q('q1', 'photos', { type: 'photo', maxCount: 2 })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('plafond-abaisse');
  });

  it('accepte un relèvement de plafond', () => {
    const avant = doc([q('q1', 'photos', { type: 'photo', maxCount: 2 })]);
    const apres = doc([q('q1', 'photos', { type: 'photo', maxCount: 5 })]);
    expect(rupture(avant, apres)).toBe(false);
  });

  it('signale un abaissement du plafond d\'un groupe répétable', () => {
    const repeat = (maxRepeat: number) =>
      doc([
        {
          id: 'r1',
          name: 'produits',
          type: 'repeat',
          label: { fr: 'Produits' },
          maxRepeat,
          children: [q('q1', 'prix', { type: 'integer' })],
        },
      ]);
    expect(rupture(repeat(50), repeat(10))).toBe(true);
    expect(rupture(repeat(10), repeat(50))).toBe(false);
  });

  it('signale une condition d\'affichage modifiée', () => {
    const avant = doc([q('q1', 'a'), q('q2', 'b', { relevant: "${a} = 'oui'" })]);
    const apres = doc([q('q1', 'a'), q('q2', 'b', { relevant: "${a} = 'non'" })]);
    expect(rupture(avant, apres)).toBe(true);
    expect(codes(avant, apres)).toContain('pertinence-modifiee');
  });
});

describe('rapport', () => {
  it('sépare les ruptures du reste des changements', () => {
    const avant = doc([q('q1', 'nom'), q('q2', 'prenom')]);
    const apres = doc([q('q1', 'nom', { label: { fr: 'Nom complet' } }), q('q3', 'age')]);
    const rapport = comparerVersions(avant, apres);

    expect(rapport.breakingChange).toBe(true);
    expect(rapport.ruptures.map((c) => c.code)).toEqual(['question-supprimee']);
    expect(rapport.changements.length).toBeGreaterThan(rapport.ruptures.length);
    expect(rapport.ruptures.every((c) => c.nature === 'rupture')).toBe(true);
  });

  it('situe chaque changement sur son élément', () => {
    const avant = doc([q('q1', 'nom')]);
    const apres = doc([q('q1', 'nom', { required: true })]);
    const [changement] = comparerVersions(avant, apres).changements;
    expect(changement?.id).toBe('q1');
    expect(changement?.name).toBe('nom');
  });
});
