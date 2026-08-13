import { describe, expect, it } from 'vitest';
import { validerDocument } from '../formulaire/index.js';
import type { DocumentFormulaire } from '../formulaire/types.js';
import { validerSoumission } from './validation.js';

const NOW = '2026-08-13T03:24:00.000Z';

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

function q(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { id: `q_${name}`, name, type, label: { fr: name }, ...extra };
}

function valider(document: DocumentFormulaire, donnees: Record<string, unknown>) {
  return validerSoumission(document, donnees, { now: NOW });
}

function codes(document: DocumentFormulaire, donnees: Record<string, unknown>): string[] {
  return valider(document, donnees).violations.map((v) => v.code);
}

describe('types de réponses', () => {
  const document = doc([
    q('nom', 'text'),
    q('age', 'integer'),
    q('taille', 'decimal'),
    q('naissance', 'date'),
    q('lieu', 'geopoint'),
  ]);

  it('accepte des réponses conformes', () => {
    const rapport = valider(document, {
      nom: 'Kouassi',
      age: 34,
      taille: 1.78,
      naissance: '1992-03-14',
      lieu: { lat: 5.333862, lng: -4.07025, accuracy: 12 },
    });
    expect(rapport.valide).toBe(true);
    expect(rapport.violations).toHaveLength(0);
  });

  it('refuse un entier reçu avec des décimales', () => {
    expect(codes(document, { age: 34.5 })).toContain('type-invalide');
  });

  it('refuse un nombre reçu comme texte', () => {
    expect(codes(document, { age: '34' })).toContain('type-invalide');
  });

  it('refuse une date mal formée', () => {
    expect(codes(document, { naissance: '14/03/1992' })).toContain('type-invalide');
  });

  it('refuse un point géographique incomplet', () => {
    expect(codes(document, { lieu: { lat: 5.33 } })).toContain('type-invalide');
  });

  it('accepte l\'absence de réponse sur une question facultative', () => {
    expect(valider(document, {}).valide).toBe(true);
  });
});

describe('questions obligatoires', () => {
  it('signale une réponse manquante', () => {
    const document = doc([q('nom', 'text', { required: true })]);
    expect(codes(document, {})).toContain('reponse-manquante');
    expect(codes(document, { nom: '   ' })).toContain('reponse-manquante');
    expect(valider(document, { nom: 'Kouassi' }).valide).toBe(true);
  });

  it('évalue une obligation conditionnelle', () => {
    const document = doc([
      q('a', 'text'),
      q('b', 'text', { required: "${a} = 'oui'" }),
    ]);
    expect(codes(document, { a: 'oui' })).toContain('reponse-manquante');
    expect(valider(document, { a: 'non' }).valide).toBe(true);
  });
});

describe('pertinence', () => {
  const document = doc([
    q('present', 'text'),
    q('prix', 'integer', { relevant: "${present} = 'oui'" }),
  ]);

  it('accepte une valeur sur une question pertinente', () => {
    expect(valider(document, { present: 'oui', prix: 500 }).valide).toBe(true);
  });

  it('refuse une valeur sur une question non pertinente', () => {
    // La donnée contredirait la logique du formulaire.
    expect(codes(document, { present: 'non', prix: 500 })).toContain(
      'valeur-non-pertinente',
    );
  });

  it('accepte une question non pertinente laissée vide', () => {
    expect(valider(document, { present: 'non' }).valide).toBe(true);
  });

  it('n\'exige pas une question obligatoire devenue non pertinente', () => {
    const conditionnel = doc([
      q('present', 'text'),
      q('prix', 'integer', { required: true, relevant: "${present} = 'oui'" }),
    ]);
    expect(valider(conditionnel, { present: 'non' }).valide).toBe(true);
  });
});

describe('contraintes', () => {
  const document = doc([
    q('prix', 'integer', { constraint: '. > 0 and . < 1000000' }),
  ]);

  it('accepte une valeur conforme', () => {
    expect(valider(document, { prix: 500 }).valide).toBe(true);
  });

  it('signale une valeur hors contrainte', () => {
    expect(codes(document, { prix: -5 })).toContain('contrainte-non-respectee');
    expect(codes(document, { prix: 2_000_000 })).toContain('contrainte-non-respectee');
  });

  it('n\'applique pas la contrainte à une question vide', () => {
    expect(valider(document, {}).valide).toBe(true);
  });
});

describe('options', () => {
  const document = doc([
    q('region', 'select_one', {
      optionsSource: { kind: 'inline' },
      options: [
        { value: 'abidjan', label: { fr: 'Abidjan' } },
        { value: 'bouake', label: { fr: 'Bouaké' } },
      ],
    }),
    q('langues', 'select_multiple', {
      optionsSource: { kind: 'inline' },
      options: [
        { value: 'fr', label: { fr: 'Français' } },
        { value: 'dioula', label: { fr: 'Dioula' } },
      ],
    }),
  ]);

  it('accepte des options existantes', () => {
    expect(
      valider(document, { region: 'abidjan', langues: ['fr', 'dioula'] }).valide,
    ).toBe(true);
  });

  it('signale une option inexistante', () => {
    expect(codes(document, { region: 'yamoussoukro' })).toContain('option-inconnue');
    expect(codes(document, { langues: ['fr', 'anglais'] })).toContain('option-inconnue');
  });

  it('ne vérifie pas les options d\'un jeu de données sans le référentiel', () => {
    // C'est le cas de l'appareil : le référentiel n'est pas dans le document,
    // et l'interface ne propose de toute façon que des options existantes.
    const externe = doc([
      q('ville', 'select_one', { optionsSource: { kind: 'dataset', dataset: 'villes' } }),
    ]);
    expect(valider(externe, { ville: 'nimporte_quoi' }).valide).toBe(true);
  });
});

describe('options venues d\'un jeu de données', () => {
  const document = doc([
    q('ville', 'select_one', { optionsSource: { kind: 'dataset', dataset: 'villes' } }),
    q('produits', 'select_multiple', {
      optionsSource: { kind: 'cascade', dataset: 'catalogue', filter: '${ville} != null' },
    }),
  ]);

  const referentiels = {
    villes: new Set(['abidjan', 'bouake']),
    catalogue: new Set(['riz', 'huile']),
  };

  function validerAvecReferentiels(donnees: Record<string, unknown>) {
    return validerSoumission(document, donnees, { now: NOW, valeursDataset: referentiels });
  }

  it('accepte une valeur du référentiel', () => {
    expect(validerAvecReferentiels({ ville: 'abidjan' }).valide).toBe(true);
  });

  it('signale une valeur absente du référentiel', () => {
    const rapport = validerAvecReferentiels({ ville: 'yamoussoukro' });
    expect(rapport.violations.map((v) => v.code)).toContain('option-inconnue');
  });

  it('vérifie chaque valeur d\'une sélection multiple', () => {
    expect(validerAvecReferentiels({ produits: ['riz', 'huile'] }).valide).toBe(true);
    expect(
      validerAvecReferentiels({ produits: ['riz', 'inconnu'] }).violations,
    ).toHaveLength(1);
  });

  it('vérifie aussi une source en cascade', () => {
    const rapport = validerAvecReferentiels({ produits: ['sucre'] });
    expect(rapport.violations.map((v) => v.name)).toEqual(['produits']);
  });

  it('ne vérifie que les référentiels fournis', () => {
    // Un référentiel absent de la liste n'est pas une raison de refuser : le
    // serveur peut n'avoir chargé que ceux qu'il connaît.
    const rapport = validerSoumission(document, { ville: 'inconnue' }, {
      now: NOW,
      valeursDataset: { catalogue: new Set(['riz']) },
    });
    expect(rapport.valide).toBe(true);
  });
});

describe('option d\'échappement', () => {
  const document = doc([
    q('motif', 'select_one', {
      optionsSource: { kind: 'inline' },
      options: [
        { value: 'rupture', label: { fr: 'Rupture' } },
        { value: 'autre', label: { fr: 'Autre' }, allowFreeText: true },
      ],
    }),
  ]);

  it('conserve le texte libre comme réponse, pas comme donnée superflue', () => {
    const rapport = valider(document, { motif: 'autre', motif_autre: 'Boutique fermée' });
    expect(rapport.valide).toBe(true);
    expect(rapport.extraData).toEqual({});
  });

  it('range le texte libre en donnée supplémentaire si l\'option ne l\'autorise pas', () => {
    const rapport = valider(document, { motif: 'rupture', motif_autre: 'inattendu' });
    expect(rapport.extraData).toEqual({ motif_autre: 'inattendu' });
  });
});

describe('pièces jointes', () => {
  const document = doc([q('photos', 'photo', { minCount: 1, maxCount: 3 })]);

  it('accepte un nombre de pièces jointes conforme', () => {
    expect(valider(document, { photos: ['a1', 'b2'] }).valide).toBe(true);
  });

  it('signale un dépassement de plafond', () => {
    expect(codes(document, { photos: ['a', 'b', 'c', 'd'] })).toContain(
      'cardinalite-depassee',
    );
  });
});

describe('groupes répétables', () => {
  const document = doc([
    {
      id: 'r1',
      name: 'produits',
      type: 'repeat',
      label: { fr: 'Produits' },
      minRepeat: 1,
      maxRepeat: 3,
      children: [
        q('prix', 'integer', { required: true, constraint: '. > 0' }),
        q('marque', 'text'),
      ],
    },
  ]);

  it('valide chaque occurrence', () => {
    const rapport = valider(document, {
      produits: [
        { prix: 500, marque: 'A' },
        { prix: 1500, marque: 'B' },
      ],
    });
    expect(rapport.valide).toBe(true);
  });

  it('situe la violation sur son occurrence', () => {
    const rapport = valider(document, {
      produits: [{ prix: 500 }, { prix: -10 }],
    });
    expect(rapport.valide).toBe(false);
    expect(rapport.violations[0]?.chemin).toBe('produits[1].prix');
  });

  it('signale un dépassement du nombre d\'occurrences', () => {
    const donnees = { produits: [{ prix: 1 }, { prix: 2 }, { prix: 3 }, { prix: 4 }] };
    expect(codes(document, donnees)).toContain('cardinalite-depassee');
  });

  it('signale un nombre d\'occurrences insuffisant', () => {
    expect(codes(document, { produits: [] })).toContain('cardinalite-insuffisante');
  });

  it('exige une réponse obligatoire dans chaque occurrence', () => {
    expect(codes(document, { produits: [{ marque: 'A' }] })).toContain(
      'reponse-manquante',
    );
  });

  it('refuse une occurrence qui n\'est pas un ensemble de réponses', () => {
    expect(codes(document, { produits: ['texte'] })).toContain('type-invalide');
  });

  it('agrège une colonne dans une contrainte extérieure', () => {
    const avecTotal = doc([
      {
        id: 'r1',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 10,
        children: [q('prix', 'integer')],
      },
      q('budget', 'integer', { constraint: '. >= sum(${produits.prix})' }),
    ]);
    expect(valider(avecTotal, { produits: [{ prix: 500 }], budget: 1000 }).valide).toBe(
      true,
    );
    expect(codes(avecTotal, { produits: [{ prix: 5000 }], budget: 1000 })).toContain(
      'contrainte-non-respectee',
    );
  });
});

describe('groupes simples', () => {
  it('garde les questions d\'un groupe à plat dans les données', () => {
    const document = doc([
      {
        id: 'g1',
        name: 'section',
        type: 'group',
        label: { fr: 'Section' },
        children: [q('nom', 'text', { required: true })],
      },
    ]);
    expect(valider(document, { nom: 'Kouassi' }).valide).toBe(true);
    expect(codes(document, {})).toContain('reponse-manquante');
  });
});

describe('données inconnues', () => {
  const document = doc([q('nom', 'text')]);

  it('conserve les clés inconnues plutôt que de les rejeter', () => {
    // Une donnée collectée par un agent ne se jette pas.
    const rapport = valider(document, { nom: 'Kouassi', ancien_champ: 'valeur' });
    expect(rapport.valide).toBe(true);
    expect(rapport.extraData).toEqual({ ancien_champ: 'valeur' });
  });

  it('conserve les clés inconnues d\'une occurrence', () => {
    const avecRepeat = doc([
      {
        id: 'r1',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 5,
        children: [q('prix', 'integer')],
      },
    ]);
    const rapport = valider(avecRepeat, {
      produits: [{ prix: 1, obsolete: 'x' }],
    });
    expect(rapport.extraData).toEqual({ 'produits[0].obsolete': 'x' });
  });
});

describe('champs dérivés', () => {
  it('ne valide pas la valeur d\'un champ calculé', () => {
    // Un calculate est un résultat, recalculable depuis le reste : ce n'est pas
    // une donnée à juger.
    const document = doc([
      q('prix', 'integer'),
      q('double', 'calculate', { calculation: '${prix} * 2' }),
    ]);
    expect(valider(document, { prix: 5, double: 'incohérent' }).valide).toBe(true);
  });
});

describe('SIGNALE — soumission de bout en bout', () => {
  const document = doc([
    q('categorie', 'select_one', {
      required: true,
      optionsSource: { kind: 'inline' },
      options: [
        { value: 'nid_de_poule', label: { fr: 'Nid de poule' } },
        { value: 'autre', label: { fr: 'Autre' }, allowFreeText: true },
      ],
    }),
    q('description', 'text', { required: true, appearance: 'multiline' }),
    q('photos', 'photo', { maxCount: 5 }),
  ]);

  it('accepte un signalement complet', () => {
    const rapport = valider(document, {
      categorie: 'nid_de_poule',
      description: 'Trou profond sur la chaussée, voie de droite.',
      photos: ['att-1', 'att-2'],
    });
    expect(rapport.valide).toBe(true);
  });

  it('relève tout ce qui manque d\'un coup', () => {
    // Le concepteur, comme le superviseur, voit l'ensemble des problèmes plutôt
    // qu'un seul à la fois.
    const rapport = valider(document, { categorie: 'inconnue', photos: ['1', '2', '3', '4', '5', '6'] });
    expect(rapport.violations.map((v) => v.code).sort()).toEqual([
      'cardinalite-depassee',
      'option-inconnue',
      'reponse-manquante',
    ]);
  });
});
