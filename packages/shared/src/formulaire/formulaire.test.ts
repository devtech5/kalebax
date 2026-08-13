import { describe, expect, it } from 'vitest';
import { validerDocument } from './index.js';
import { parcourir, type DocumentFormulaire } from './types.js';

/** Document minimal valide, à altérer dans chaque test. */
function documentBase(children: unknown[] = []): Record<string, unknown> {
  return {
    schemaVersion: 1,
    title: { fr: 'Formulaire de test' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children,
  };
}

function question(
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `q_${name}`,
    name,
    type: 'text',
    label: { fr: name },
    ...extra,
  };
}

/** Codes d'anomalie d'un document censé être refusé. */
function refus(brut: unknown): string[] {
  const resultat = validerDocument(brut);
  if (resultat.ok) throw new Error('Ce document aurait dû être refusé.');
  return resultat.anomalies.map((a) => a.code);
}

function accepte(brut: unknown): DocumentFormulaire {
  const resultat = validerDocument(brut);
  if (!resultat.ok) {
    throw new Error(
      `Refusé alors qu'il devait passer : ${resultat.anomalies.map((a) => a.message).join(' / ')}`,
    );
  }
  return resultat.document;
}

describe('structure', () => {
  it('accepte un document minimal', () => {
    expect(accepte(documentBase()).schemaVersion).toBe(1);
  });

  it('refuse un document qui n\'est pas un objet', () => {
    expect(refus(null).length).toBeGreaterThan(0);
    expect(refus('texte').length).toBeGreaterThan(0);
    expect(refus([]).length).toBeGreaterThan(0);
  });

  it('refuse une clé inconnue', () => {
    // Attrape « requiered » au lieu de « required » dans un document écrit à la
    // main ou converti depuis XLSForm.
    const doc = documentBase([question('a', { requiered: true })]);
    expect(refus(doc).length).toBeGreaterThan(0);
  });

  it('refuse un nom de variable mal formé', () => {
    for (const mauvais of ['Prix', 'prix unitaire', '1prix', 'prix-unitaire', 'prïx']) {
      const doc = documentBase([question('ok'), { ...question('ok'), name: mauvais }]);
      expect(refus(doc).length).toBeGreaterThan(0);
    }
  });

  it('accepte les noms bien formés', () => {
    accepte(documentBase([question('prix_unitaire'), question('_interne'), question('q1')]));
  });

  it('refuse un type de question inconnu', () => {
    expect(refus(documentBase([question('a', { type: 'curseur' })])).length).toBeGreaterThan(0);
  });
});

describe('langues', () => {
  it('refuse une langue par défaut absente de la liste', () => {
    const doc = { ...documentBase(), defaultLanguage: 'en', languages: ['fr'] };
    expect(refus(doc)).toContain('langue-par-defaut-absente');
  });

  it('refuse un libellé non traduit dans la langue par défaut', () => {
    const doc = documentBase([question('a', { label: { en: 'Age' } })]);
    expect(refus(doc)).toContain('libelle-incomplet');
  });

  it('accepte un formulaire multilingue complet', () => {
    accepte({
      ...documentBase([question('a', { label: { fr: 'Âge', en: 'Age' } })]),
      languages: ['fr', 'en'],
    });
  });
});

describe('unicité', () => {
  it('refuse deux questions de même nom', () => {
    const doc = documentBase([question('prix'), { ...question('prix'), id: 'q_autre' }]);
    expect(refus(doc)).toContain('nom-en-double');
  });

  it('refuse deux éléments de même identifiant', () => {
    const doc = documentBase([question('a'), { ...question('b'), id: 'q_a' }]);
    expect(refus(doc)).toContain('identifiant-en-double');
  });

  it('détecte un doublon à travers les groupes', () => {
    const doc = documentBase([
      question('prix'),
      {
        id: 'g1',
        name: 'section',
        type: 'group',
        label: { fr: 'Section' },
        children: [{ ...question('prix'), id: 'q_prix_2' }],
      },
    ]);
    expect(refus(doc)).toContain('nom-en-double');
  });
});

describe('listes d\'options', () => {
  const optionsInline = {
    type: 'select_one',
    optionsSource: { kind: 'inline' },
    options: [
      { value: 'abidjan', label: { fr: 'Abidjan' } },
      { value: 'bouake', label: { fr: 'Bouaké' } },
    ],
  };

  it('accepte une liste écrite dans le formulaire', () => {
    accepte(documentBase([question('region', optionsInline)]));
  });

  it('refuse une question à choix sans source d\'options', () => {
    expect(refus(documentBase([question('region', { type: 'select_one' })]))).toContain(
      'source-options-manquante',
    );
  });

  it('refuse une liste inline vide', () => {
    const doc = documentBase([
      question('region', { type: 'select_one', optionsSource: { kind: 'inline' }, options: [] }),
    ]);
    expect(refus(doc)).toContain('options-manquantes');
  });

  it('refuse des options écrites en plus d\'un jeu de données', () => {
    const doc = documentBase([
      question('region', {
        type: 'select_one',
        optionsSource: { kind: 'dataset', dataset: 'regions' },
        options: [{ value: 'x', label: { fr: 'X' } }],
      }),
    ]);
    expect(refus(doc)).toContain('options-superflues');
  });

  it('refuse deux options de même valeur', () => {
    const doc = documentBase([
      question('region', {
        ...optionsInline,
        options: [
          { value: 'abidjan', label: { fr: 'Abidjan' } },
          { value: 'abidjan', label: { fr: 'Abidjan bis' } },
        ],
      }),
    ]);
    expect(refus(doc)).toContain('option-en-double');
  });

  it('refuse une liste d\'options sur une question qui n\'est pas à choix', () => {
    const doc = documentBase([question('nom', { optionsSource: { kind: 'inline' } })]);
    expect(refus(doc)).toContain('options-inattendues');
  });

  it('accepte un filtre en cascade', () => {
    accepte(
      documentBase([
        question('region', { type: 'select_one', optionsSource: { kind: 'dataset', dataset: 'regions' } }),
        question('ville', {
          type: 'select_one',
          optionsSource: { kind: 'cascade', dataset: 'villes', filter: '${region} != null' },
        }),
      ]),
    );
  });

  it('refuse un filtre en cascade qui référence une question inexistante', () => {
    const doc = documentBase([
      question('ville', {
        type: 'select_one',
        optionsSource: { kind: 'cascade', dataset: 'villes', filter: '${inexistante} = 1' },
      }),
    ]);
    expect(refus(doc)).toContain('expression-reference-inconnue');
  });
});

describe('option d\'échappement « Autre, précisez »', () => {
  it('accepte une option à texte libre', () => {
    accepte(
      documentBase([
        question('motif', {
          type: 'select_one',
          optionsSource: { kind: 'inline' },
          options: [
            { value: 'rupture', label: { fr: 'Rupture de stock' } },
            { value: 'autre', label: { fr: 'Autre' }, allowFreeText: true, freeTextLabel: { fr: 'Précisez' } },
          ],
        }),
      ]),
    );
  });

  it('refuse un libellé de champ libre sans autorisation de saisie', () => {
    const doc = documentBase([
      question('motif', {
        type: 'select_one',
        optionsSource: { kind: 'inline' },
        options: [{ value: 'autre', label: { fr: 'Autre' }, freeTextLabel: { fr: 'Précisez' } }],
      }),
    ]);
    expect(refus(doc)).toContain('texte-libre-incoherent');
  });

  it('refuse une clé dérivée qui écraserait une question existante', () => {
    // motif_autre serait produit par l'option libre, et existe déjà.
    const doc = documentBase([
      question('motif', {
        type: 'select_one',
        optionsSource: { kind: 'inline' },
        options: [{ value: 'autre', label: { fr: 'Autre' }, allowFreeText: true }],
      }),
      question('motif_autre'),
    ]);
    expect(refus(doc)).toContain('collision-cle-derivee');
  });
});

describe('questions média', () => {
  it('refuse une question photo sans plafond', () => {
    expect(refus(documentBase([question('photos', { type: 'photo' })]))).toContain(
      'plafond-media-manquant',
    );
  });

  it('accepte plusieurs photos plafonnées', () => {
    accepte(documentBase([question('photos', { type: 'photo', minCount: 0, maxCount: 5 })]));
  });

  it('refuse un minimum supérieur au maximum', () => {
    const doc = documentBase([question('photos', { type: 'photo', minCount: 6, maxCount: 5 })]);
    expect(refus(doc)).toContain('plafond-incoherent');
  });

  it('refuse un plafond sur une question sans pièce jointe', () => {
    expect(refus(documentBase([question('nom', { maxCount: 3 })]))).toContain(
      'plafond-inattendu',
    );
  });
});

describe('groupes répétables', () => {
  function repeat(name: string, children: unknown[], extra: Record<string, unknown> = {}) {
    return {
      id: `r_${name}`,
      name,
      type: 'repeat',
      label: { fr: name },
      maxRepeat: 50,
      children,
      ...extra,
    };
  }

  it('accepte un groupe répétable plafonné', () => {
    accepte(documentBase([repeat('produits', [question('prix', { type: 'integer' })])]));
  });

  it('refuse un groupe répétable sans plafond', () => {
    const sansPlafond = {
      id: 'r_x',
      name: 'x',
      type: 'repeat',
      label: { fr: 'X' },
      children: [],
    };
    expect(refus(documentBase([sansPlafond])).length).toBeGreaterThan(0);
  });

  it('accepte deux niveaux d\'imbrication', () => {
    accepte(
      documentBase([
        repeat('visites', [repeat('produits', [question('prix', { type: 'integer' })])]),
      ]),
    );
  });

  it('refuse trois niveaux d\'imbrication', () => {
    const doc = documentBase([
      repeat('a', [repeat('b', [repeat('c', [question('prix', { type: 'integer' })])])]),
    ]);
    expect(refus(doc)).toContain('repetition-trop-imbriquee');
  });

  it('agrège une colonne depuis l\'extérieur', () => {
    accepte(
      documentBase([
        repeat('produits', [question('prix', { type: 'integer' })]),
        question('total', { type: 'calculate', calculation: 'sum(${produits.prix})' }),
      ]),
    );
  });
});

describe('champs calculés et notes', () => {
  it('refuse un champ calculé sans expression', () => {
    expect(refus(documentBase([question('total', { type: 'calculate' })]))).toContain(
      'calcul-manquant',
    );
  });

  it('refuse une expression de calcul sur une question saisie', () => {
    const doc = documentBase([question('nom', { calculation: '1 + 1' })]);
    expect(refus(doc)).toContain('calcul-inattendu');
  });

  it('signale un attribut sans effet sur un champ calculé', () => {
    const doc = documentBase([
      question('total', { type: 'calculate', calculation: '1 + 1', required: true }),
    ]);
    expect(refus(doc)).toContain('attribut-inutile');
  });

  it('signale un attribut sans effet sur une note', () => {
    const doc = documentBase([question('info', { type: 'note', required: true })]);
    expect(refus(doc)).toContain('attribut-inutile');
  });
});

describe('expressions', () => {
  it('refuse une expression syntaxiquement invalide', () => {
    const doc = documentBase([question('a', { relevant: '${b} ==' }), question('b')]);
    expect(refus(doc)).toContain('expression-syntaxe');
  });

  it('refuse une référence à une question inexistante', () => {
    const doc = documentBase([question('a', { relevant: "${inexistante} = 'oui'" })]);
    expect(refus(doc)).toContain('expression-reference-inconnue');
  });

  it('accepte une référence à une question du formulaire', () => {
    accepte(
      documentBase([
        question('present', { type: 'select_one', optionsSource: { kind: 'inline' }, options: [{ value: 'oui', label: { fr: 'Oui' } }] }),
        question('prix', { type: 'integer', relevant: "${present} = 'oui'", constraint: '. > 0' }),
      ]),
    );
  });

  it('accepte une contrainte qui se réfère à elle-même', () => {
    // constraint est évaluée sur une valeur qui existe déjà : ce n'est pas une
    // boucle de calcul.
    accepte(documentBase([question('prix', { type: 'integer', constraint: '. > 0 and . < 1000000' })]));
  });
});

describe('cycles de dépendances', () => {
  it('refuse une boucle entre champs calculés', () => {
    const doc = documentBase([
      question('a', { type: 'calculate', calculation: '${b} + 1' }),
      question('b', { type: 'calculate', calculation: '${c} + 1' }),
      question('c', { type: 'calculate', calculation: '${a} + 1' }),
    ]);
    expect(refus(doc)).toContain('cycle-de-dependances');
  });

  it('refuse une question dont la pertinence dépend d\'elle-même', () => {
    const doc = documentBase([question('a', { relevant: '${a} = 1' })]);
    expect(refus(doc)).toContain('cycle-de-dependances');
  });

  it('accepte une chaîne de calculs sans boucle', () => {
    accepte(
      documentBase([
        question('prix', { type: 'integer' }),
        question('quantite', { type: 'integer' }),
        question('total', { type: 'calculate', calculation: '${prix} * ${quantite}' }),
      ]),
    );
  });
});

describe('version du format', () => {
  it('refuse un document trop récent sans tenter de l\'interpréter', () => {
    const doc = { ...documentBase([question('a', { type: 'inconnu_futur' })]), schemaVersion: 99 };
    const anomalies = refus(doc);
    // Un seul diagnostic : le reste du document ne peut pas être jugé.
    expect(anomalies).toEqual(['version-trop-recente']);
  });
});

describe('parcours du document', () => {
  it('visite tous les éléments dans l\'ordre d\'affichage', () => {
    const document = accepte(
      documentBase([
        question('a'),
        {
          id: 'g1',
          name: 'section',
          type: 'group',
          label: { fr: 'Section' },
          children: [question('b'), question('c')],
        },
      ]),
    );
    expect([...parcourir(document)].map((s) => s.element.name)).toEqual([
      'a',
      'section',
      'b',
      'c',
    ]);
  });

  it('note les groupes répétables englobants', () => {
    const document = accepte(
      documentBase([
        {
          id: 'r1',
          name: 'produits',
          type: 'repeat',
          label: { fr: 'Produits' },
          maxRepeat: 10,
          children: [question('prix', { type: 'integer' })],
        },
      ]),
    );
    const prix = [...parcourir(document)].find((s) => s.element.name === 'prix');
    expect(prix?.repetitions).toEqual(['produits']);
    expect(prix?.chemin).toEqual(['produits', 'prix']);
  });
});

describe('SIGNALE — cas de bout en bout', () => {
  // Le formulaire de docs/analyse-signale.md §6. Si le schéma ne sait pas le
  // produire sans code applicatif, le schéma est incomplet.
  const signale = {
    schemaVersion: 1,
    title: { fr: "Signalement d'incident urbain" },
    defaultLanguage: 'fr',
    languages: ['fr', 'en'],
    settings: {
      requireStartGeopoint: true,
      minGeopointAccuracy: 50,
      allowDraftSave: true,
    },
    children: [
      {
        id: 'q_categorie',
        name: 'categorie',
        type: 'select_one',
        label: { fr: 'Catégorie' },
        required: true,
        optionsSource: { kind: 'dataset', dataset: 'categories_incidents' },
      },
      {
        id: 'q_description',
        name: 'description',
        type: 'text',
        label: { fr: 'Description' },
        hint: { fr: "Décrivez l'incident en détail" },
        appearance: 'multiline',
        required: true,
      },
      {
        id: 'q_photos',
        name: 'photos',
        type: 'photo',
        label: { fr: 'Photos' },
        required: false,
        maxCount: 5,
      },
    ],
  };

  it('produit SIGNALE sans une ligne de code applicatif', () => {
    const document = accepte(signale);
    expect([...parcourir(document)].map((s) => s.element.name)).toEqual([
      'categorie',
      'description',
      'photos',
    ]);
  });

  it('plafonne les photos comme l\'application d\'origine', () => {
    const document = accepte(signale);
    const photos = [...parcourir(document)].find((s) => s.element.name === 'photos');
    expect(photos?.element).toMatchObject({ type: 'photo', maxCount: 5 });
  });
});
