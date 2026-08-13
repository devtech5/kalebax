import { describe, expect, it } from 'vitest';
import { construireGraphe, type Dependance } from './dependances.js';
import { analyser } from './index.js';

function references(source: string): readonly string[] {
  const resultat = analyser(source);
  if (!resultat.ok) throw new Error('analyse refusée');
  return resultat.expression.references;
}

describe('extraction des références', () => {
  it('relève les questions lues', () => {
    expect(references('${a} + ${b}')).toEqual(['a', 'b']);
  });

  it('ne relève chaque question qu\'une fois', () => {
    expect(references('${a} + ${a} * ${a}')).toEqual(['a']);
  });

  it('ne retient que le groupe pour un chemin composé', () => {
    expect(references('sum(${produits.prix})')).toEqual(['produits']);
  });

  it('descend dans les appels de fonction', () => {
    expect(references("if(${a} = 1, concat(${b}, ${c}), null)")).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('ne relève rien sur une expression constante', () => {
    expect(references('today()')).toEqual([]);
  });
});

describe('ordre d\'évaluation', () => {
  it('place une question après celles qu\'elle lit', () => {
    const dependances: Dependance[] = [
      { nom: 'total', lit: ['prix', 'quantite'] },
      { nom: 'prix', lit: [] },
      { nom: 'quantite', lit: [] },
    ];
    const { ordre, cycle } = construireGraphe(dependances);
    expect(cycle).toBeNull();
    expect(ordre.indexOf('total')).toBeGreaterThan(ordre.indexOf('prix'));
    expect(ordre.indexOf('total')).toBeGreaterThan(ordre.indexOf('quantite'));
  });

  it('ordonne une chaîne de dépendances transitives', () => {
    const { ordre } = construireGraphe([
      { nom: 'c', lit: ['b'] },
      { nom: 'b', lit: ['a'] },
      { nom: 'a', lit: [] },
    ]);
    expect(ordre).toEqual(['a', 'b', 'c']);
  });

  it('ignore une référence hors du formulaire', () => {
    // La référence inconnue est signalée par la validation, pas par le graphe.
    const { ordre, cycle } = construireGraphe([{ nom: 'a', lit: ['ailleurs'] }]);
    expect(cycle).toBeNull();
    expect(ordre).toEqual(['a']);
  });
});

describe('détection de cycles', () => {
  it('refuse un cycle et en donne le chemin', () => {
    const { ordre, cycle } = construireGraphe([
      { nom: 'prix', lit: ['total'] },
      { nom: 'remise', lit: ['prix'] },
      { nom: 'total', lit: ['remise'] },
    ]);
    expect(ordre).toEqual([]);
    expect(cycle).not.toBeNull();
    // Le chemin boucle sur lui-même, quel que soit son point de départ.
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['prix', 'remise', 'total']));
  });

  it('refuse une question qui se lit elle-même', () => {
    const { cycle } = construireGraphe([{ nom: 'a', lit: ['a'] }]);
    expect(cycle).toEqual(['a', 'a']);
  });

  it('isole le cycle des questions saines', () => {
    const { cycle } = construireGraphe([
      { nom: 'saine', lit: [] },
      { nom: 'x', lit: ['y'] },
      { nom: 'y', lit: ['x'] },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle).not.toContain('saine');
  });

  it('accepte un graphe en losange, qui n\'est pas un cycle', () => {
    const { ordre, cycle } = construireGraphe([
      { nom: 'd', lit: ['b', 'c'] },
      { nom: 'b', lit: ['a'] },
      { nom: 'c', lit: ['a'] },
      { nom: 'a', lit: [] },
    ]);
    expect(cycle).toBeNull();
    expect(ordre).toHaveLength(4);
    expect(ordre.indexOf('d')).toBe(3);
  });
});
