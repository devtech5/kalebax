import { describe, expect, it } from 'vitest';
import { FONCTIONS } from '../expression/fonctions.js';
import { validerDocument } from './index.js';
import { SIGNATURES } from './typage.js';

function documentBase(children: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    title: { fr: 'Test' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children,
  };
}

function q(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { id: `q_${name}`, name, type, label: { fr: name }, ...extra };
}

function codes(brut: unknown): string[] {
  const resultat = validerDocument(brut);
  return resultat.ok ? [] : resultat.anomalies.map((a) => a.code);
}

function accepte(brut: unknown): void {
  const resultat = validerDocument(brut);
  if (!resultat.ok) {
    throw new Error(
      `Refusé alors qu'il devait passer : ${resultat.anomalies.map((a) => a.message).join(' / ')}`,
    );
  }
}

describe('cohérence des tables', () => {
  it('déclare une signature pour chaque fonction du langage', () => {
    // Deux tables séparées — sémantique d'exécution et typage statique — mais
    // elles doivent couvrir exactement les mêmes fonctions, sinon l'une des
    // deux dérive en silence.
    expect(Object.keys(SIGNATURES).sort()).toEqual(Object.keys(FONCTIONS).sort());
  });

  it('respecte l\'arité déclarée dans chaque signature', () => {
    for (const [nom, signature] of Object.entries(SIGNATURES)) {
      const fonction = FONCTIONS[nom];
      expect(fonction, nom).toBeDefined();
      if (fonction === undefined) continue;
      if (signature.reste === undefined) {
        expect(signature.arguments.length, nom).toBe(fonction.ariteMax ?? 0);
      }
    }
  });
});

describe('types incompatibles', () => {
  it('refuse d\'additionner du texte', () => {
    const doc = documentBase([
      q('nom', 'text'),
      q('total', 'calculate', { calculation: '${nom} + 1' }),
    ]);
    expect(codes(doc)).toContain('expression-type-incompatible');
  });

  it('refuse de comparer du texte à un nombre', () => {
    const doc = documentBase([
      q('nom', 'text'),
      q('age', 'integer', { relevant: '${nom} > 5' }),
    ]);
    expect(codes(doc)).toContain('expression-type-incompatible');
  });

  it('refuse une condition sur un nombre', () => {
    const doc = documentBase([
      q('age', 'integer'),
      q('suite', 'text', { relevant: '${age} and true' }),
    ]);
    expect(codes(doc)).toContain('expression-type-incompatible');
  });

  it('accepte une conversion explicite', () => {
    accepte(
      documentBase([
        q('nom', 'text'),
        q('total', 'calculate', { calculation: 'number(${nom}) + 1' }),
      ]),
    );
  });

  it('accepte l\'égalité entre types différents', () => {
    // L'égalité accepte tout, y compris null : c'est la seule façon d'écrire
    // « cette question n'a pas de réponse ».
    accepte(
      documentBase([
        q('nom', 'text'),
        q('suite', 'text', { relevant: '${nom} = null' }),
      ]),
    );
  });

  it('ne suppose rien du type d\'un champ calculé', () => {
    // Le type d'un calculate dépend de son expression : le supposer serait la
    // première source de refus injustifié.
    accepte(
      documentBase([
        q('base', 'integer'),
        q('interm', 'calculate', { calculation: '${base} * 2' }),
        q('suite', 'text', { relevant: '${interm} > 10' }),
      ]),
    );
  });

  it('ne se prononce pas sur les types géographiques', () => {
    accepte(
      documentBase([
        q('lieu', 'geopoint'),
        q('suite', 'text', { relevant: '${lieu} != null' }),
      ]),
    );
  });

  it('refuse un mauvais type d\'argument de fonction', () => {
    const doc = documentBase([
      q('age', 'integer'),
      q('taille', 'calculate', { calculation: 'string-length(${age})' }),
    ]);
    expect(codes(doc)).toContain('expression-type-incompatible');
  });

  it('accepte un argument dont le type est libre', () => {
    accepte(
      documentBase([
        q('langues', 'select_multiple', {
          optionsSource: { kind: 'inline' },
          options: [{ value: 'fr', label: { fr: 'Français' } }],
        }),
        q('nb', 'calculate', { calculation: 'count-selected(${langues})' }),
      ]),
    );
  });

  it('type la question courante dans une contrainte', () => {
    const doc = documentBase([q('nom', 'text', { constraint: '. > 5' })]);
    expect(codes(doc)).toContain('expression-type-incompatible');
    accepte(documentBase([q('age', 'integer', { constraint: '. > 5' })]));
  });
});

describe('type de retour attendu par attribut', () => {
  it('refuse un relevant qui ne produit pas une condition', () => {
    const doc = documentBase([
      q('age', 'integer'),
      q('suite', 'text', { relevant: '${age} + 1' }),
    ]);
    expect(codes(doc)).toContain('retour-incompatible');
  });

  it('refuse un repeatCount textuel', () => {
    const doc = documentBase([
      q('nom', 'text'),
      {
        id: 'r1',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 10,
        repeatCount: '${nom}',
        children: [q('prix', 'integer')],
      },
    ]);
    expect(codes(doc)).toContain('retour-incompatible');
  });

  it('accepte un repeatCount numérique', () => {
    accepte(
      documentBase([
        q('nombre_produits', 'integer'),
        {
          id: 'r1',
          name: 'produits',
          type: 'repeat',
          label: { fr: 'Produits' },
          maxRepeat: 10,
          repeatCount: '${nombre_produits}',
          children: [q('prix', 'integer')],
        },
      ]),
    );
  });
});

describe('ordre de déclaration', () => {
  it('refuse une référence à une question posée plus loin', () => {
    const doc = documentBase([
      q('a', 'text', { relevant: "${b} = 'oui'" }),
      q('b', 'text'),
    ]);
    expect(codes(doc)).toContain('reference-posterieure');
  });

  it('accepte une référence à une question posée avant', () => {
    accepte(
      documentBase([q('b', 'text'), q('a', 'text', { relevant: "${b} = 'oui'" })]),
    );
  });

  it('exempte les agrégats de groupe répétable', () => {
    // sum(${produits.prix}) porte sur la collection entière, pas sur une
    // réponse en attente.
    accepte(
      documentBase([
        {
          id: 'r1',
          name: 'produits',
          type: 'repeat',
          label: { fr: 'Produits' },
          maxRepeat: 50,
          children: [q('prix', 'integer')],
        },
        q('total', 'calculate', { calculation: 'sum(${produits.prix})' }),
      ]),
    );
  });

  it('refuse un groupe dont la pertinence dépend de son contenu', () => {
    const doc = documentBase([
      {
        id: 'g1',
        name: 'section',
        type: 'group',
        label: { fr: 'Section' },
        relevant: "${interne} = 'oui'",
        children: [q('interne', 'text')],
      },
    ]);
    expect(codes(doc)).toContain('reference-posterieure');
  });
});
