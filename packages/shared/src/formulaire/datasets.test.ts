import { describe, expect, it } from 'vitest';
import { validerDocument } from './index.js';
import { datasetsReferences, type DocumentFormulaire } from './types.js';

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

function q(name: string, extra: Record<string, unknown> = {}) {
  return { id: `q_${name}`, name, type: 'text', label: { fr: name }, ...extra };
}

describe('jeux de données référencés', () => {
  it('relève un jeu de données', () => {
    const document = doc([
      q('ville', {
        type: 'select_one',
        optionsSource: { kind: 'dataset', dataset: 'villes' },
      }),
    ]);
    expect(datasetsReferences(document)).toEqual(['villes']);
  });

  it('relève aussi les sources en cascade', () => {
    const document = doc([
      q('region', { type: 'select_one', optionsSource: { kind: 'dataset', dataset: 'regions' } }),
      q('ville', {
        type: 'select_one',
        optionsSource: { kind: 'cascade', dataset: 'villes', filter: '${region} != null' },
      }),
    ]);
    expect(datasetsReferences(document).sort()).toEqual(['regions', 'villes']);
  });

  it('ne relève pas les listes écrites dans le formulaire', () => {
    const document = doc([
      q('region', {
        type: 'select_one',
        optionsSource: { kind: 'inline' },
        options: [{ value: 'abidjan', label: { fr: 'Abidjan' } }],
      }),
    ]);
    expect(datasetsReferences(document)).toEqual([]);
  });

  it('ne compte qu\'une fois un jeu utilisé deux fois', () => {
    const document = doc([
      q('depart', { type: 'select_one', optionsSource: { kind: 'dataset', dataset: 'villes' } }),
      q('arrivee', { type: 'select_one', optionsSource: { kind: 'dataset', dataset: 'villes' } }),
    ]);
    expect(datasetsReferences(document)).toEqual(['villes']);
  });

  it('descend dans les groupes et les répétitions', () => {
    const document = doc([
      {
        id: 'r1',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 20,
        children: [
          q('produit', {
            type: 'select_one',
            optionsSource: { kind: 'dataset', dataset: 'catalogue' },
          }),
        ],
      },
    ]);
    expect(datasetsReferences(document)).toEqual(['catalogue']);
  });

  it('ne relève rien sur un formulaire sans référentiel', () => {
    expect(datasetsReferences(doc([q('nom')]))).toEqual([]);
  });
});
