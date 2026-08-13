import { describe, expect, it } from 'vitest';
import { reduireEnBooleen } from './valeur.js';

describe('reduireEnBooleen', () => {
  it('masque une question dont le relevant est indécidable', () => {
    expect(reduireEnBooleen(null, 'relevant')).toBe(false);
  });

  it('accepte une saisie dont la contrainte est indécidable', () => {
    // Règle produit : une contrainte qu'on ne sait pas évaluer ne doit jamais
    // empêcher une donnée d'être collectée. Voir evaluateur-expressions.md §4.3.
    expect(reduireEnBooleen(null, 'constraint')).toBe(true);
  });

  it("n'exige jamais une réponse sur une condition indécidable", () => {
    expect(reduireEnBooleen(null, 'required')).toBe(false);
  });

  it("masque une option dont l'appartenance est indécidable", () => {
    expect(reduireEnBooleen(null, 'filter')).toBe(false);
  });

  it('laisse passer les booléens tels quels', () => {
    for (const attribut of ['relevant', 'constraint', 'required', 'filter'] as const) {
      expect(reduireEnBooleen(true, attribut)).toBe(true);
      expect(reduireEnBooleen(false, attribut)).toBe(false);
    }
  });

  it('ne traite aucune valeur non booléenne comme vraie', () => {
    // Pas de « truthiness » : le langage ne convertit pas implicitement (§5).
    expect(reduireEnBooleen(1, 'relevant')).toBe(false);
    expect(reduireEnBooleen('oui', 'relevant')).toBe(false);
    expect(reduireEnBooleen([], 'relevant')).toBe(false);
  });
});
