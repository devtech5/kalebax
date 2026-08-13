import { validerDocument, validerSoumission, type DocumentFormulaire } from '@kalebax/shared';
import { describe, expect, it } from 'vitest';
import { RuntimeSaisie } from './runtime.js';

const NOW = '2026-08-13T09:00:00.000Z';

function doc(children: unknown[]): DocumentFormulaire {
  const resultat = validerDocument({
    schemaVersion: 1,
    title: { fr: 'Relevé' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children,
  });
  if (!resultat.ok) {
    throw new Error(resultat.anomalies.map((a) => a.message).join(' / '));
  }
  return resultat.document;
}

function q(name: string, type = 'text', extra: Record<string, unknown> = {}) {
  return { id: `q_${name}`, name, type, label: { fr: name }, ...extra };
}

function creer(children: unknown[], donneesInitiales?: Record<string, unknown>) {
  return RuntimeSaisie.creer(doc(children), { now: NOW, donneesInitiales });
}

describe('saisie simple', () => {
  it('enregistre et relit une réponse', () => {
    const runtime = creer([q('nom')]);
    runtime.repondre('nom', 'Boutique Awa');
    expect(runtime.lire('nom')).toBe('Boutique Awa');
    expect(runtime.finaliser().donnees).toEqual({ nom: 'Boutique Awa' });
  });

  it('reprend un brouillon', () => {
    const runtime = creer([q('nom')], { nom: 'Déjà saisi' });
    expect(runtime.lire('nom')).toBe('Déjà saisi');
  });

  it('efface une réponse mise à null', () => {
    const runtime = creer([q('nom')], { nom: 'Ancien' });
    runtime.repondre('nom', null);
    expect(runtime.finaliser().donnees).toEqual({});
  });

  it('refuse d\'écrire dans un champ calculé', () => {
    // Sa valeur serait écrasée au premier recalcul : accepter la saisie ferait
    // croire à l'agent qu'il maîtrise quelque chose.
    const runtime = creer([
      q('prix', 'integer'),
      q('double', 'calculate', { calculation: '${prix} * 2' }),
    ]);
    runtime.repondre('prix', 100);
    runtime.repondre('double', 999);
    expect(runtime.lire('double')).toBe(200);
  });
});

describe('réponses masquées', () => {
  const children = [
    q('present'),
    q('prix', 'integer', { relevant: "${present} = 'oui'" }),
  ];

  it('retire de la soumission une réponse devenue non pertinente', () => {
    const runtime = creer(children);
    runtime.repondre('present', 'oui');
    runtime.repondre('prix', 500);
    runtime.repondre('present', 'non');

    expect(runtime.finaliser().donnees).toEqual({ present: 'non' });
  });

  it('rend la réponse si la condition redevient vraie', () => {
    // Le drame classique : l'agent coche « non » par erreur, douze réponses
    // disparaissent, il recoche « oui » — tout serait à ressaisir.
    const runtime = creer(children);
    runtime.repondre('present', 'oui');
    runtime.repondre('prix', 500);
    runtime.repondre('present', 'non');
    runtime.repondre('present', 'oui');

    expect(runtime.lire('prix')).toBe(500);
    expect(runtime.finaliser().donnees).toEqual({ present: 'oui', prix: 500 });
  });

  it('garde la réserve hors des données produites', () => {
    const runtime = creer(children);
    runtime.repondre('present', 'oui');
    runtime.repondre('prix', 500);
    runtime.repondre('present', 'non');

    expect(runtime.valeursEnReserve()).toEqual({ prix: 500 });
    expect(JSON.stringify(runtime.finaliser().donnees)).not.toContain('500');
  });

  it('n\'exige pas une question obligatoire masquée', () => {
    const runtime = creer([
      q('present'),
      q('prix', 'integer', { required: true, relevant: "${present} = 'oui'" }),
    ]);
    runtime.repondre('present', 'non');
    expect(runtime.violations()).toHaveLength(0);
  });
});

describe('calculs', () => {
  it('propage une chaîne de calculs', () => {
    const runtime = creer([
      q('prix', 'integer'),
      q('quantite', 'integer'),
      q('sous_total', 'calculate', { calculation: '${prix} * ${quantite}' }),
      q('total', 'calculate', { calculation: '${sous_total} + 100' }),
    ]);

    runtime.repondre('prix', 200);
    runtime.repondre('quantite', 3);

    expect(runtime.lire('sous_total')).toBe(600);
    expect(runtime.lire('total')).toBe(700);
  });

  it('recalcule à chaque changement', () => {
    const runtime = creer([
      q('prix', 'integer'),
      q('double', 'calculate', { calculation: '${prix} * 2' }),
    ]);
    runtime.repondre('prix', 10);
    expect(runtime.lire('double')).toBe(20);
    runtime.repondre('prix', 25);
    expect(runtime.lire('double')).toBe(50);
  });

  it('fige l\'instant de la saisie', () => {
    // Le serveur doit aboutir au même verdict trois jours plus tard.
    const runtime = creer([q('jour', 'calculate', { calculation: 'today()' })]);
    expect(runtime.lire('jour')).toBe('2026-08-13');
  });
});

describe('valeurs par défaut', () => {
  it('applique un défaut sur une question vide', () => {
    const runtime = creer([q('devise', 'text', { default: "'FCFA'" })]);
    runtime.appliquerDefaut('devise');
    expect(runtime.lire('devise')).toBe('FCFA');
  });

  it('ne réapplique pas un défaut après effacement', () => {
    // Un champ qui se remplit tout seul après avoir été vidé est
    // incompréhensible.
    const runtime = creer([q('devise', 'text', { default: "'FCFA'" })]);
    runtime.appliquerDefaut('devise');
    runtime.repondre('devise', null);
    runtime.appliquerDefaut('devise');
    expect(runtime.lire('devise')).toBeUndefined();
  });

  it('n\'écrase pas une réponse existante', () => {
    const runtime = creer([q('devise', 'text', { default: "'FCFA'" })], {
      devise: 'EUR',
    });
    runtime.appliquerDefaut('devise');
    expect(runtime.lire('devise')).toBe('EUR');
  });
});

describe('violations', () => {
  it('signale une question obligatoire vide', () => {
    const runtime = creer([q('nom', 'text', { required: true })]);
    expect(runtime.violations().map((v) => v.code)).toEqual(['requise']);
  });

  it('signale une contrainte non respectée', () => {
    const runtime = creer([
      q('prix', 'integer', {
        constraint: '. > 0',
        constraintMessage: { fr: 'Le prix doit être positif' },
      }),
    ]);
    runtime.repondre('prix', -5);

    const violations = runtime.violations();
    expect(violations[0]?.code).toBe('contrainte');
    expect(violations[0]?.message).toBe('Le prix doit être positif');
  });

  it('n\'applique pas la contrainte à une question vide', () => {
    const runtime = creer([q('prix', 'integer', { constraint: '. > 0' })]);
    expect(runtime.violations()).toHaveLength(0);
  });

  it('évalue une obligation conditionnelle', () => {
    const runtime = creer([
      q('a'),
      q('b', 'text', { required: "${a} = 'oui'" }),
    ]);
    runtime.repondre('a', 'non');
    expect(runtime.violations()).toHaveLength(0);
    runtime.repondre('a', 'oui');
    expect(runtime.violations().map((v) => v.name)).toEqual(['b']);
  });

  it('finalise malgré les violations', () => {
    // Un agent bloqué par une contrainte mal écrite à 300 km du bureau est un
    // échec produit.
    const runtime = creer([q('nom', 'text', { required: true })]);
    const resultat = runtime.finaliser();

    expect(resultat.complet).toBe(false);
    expect(resultat.violations).toHaveLength(1);
    expect(resultat.donnees).toEqual({});
  });
});

describe('groupes répétables', () => {
  const children = [
    {
      id: 'r_produits',
      name: 'produits',
      type: 'repeat',
      label: { fr: 'Produits' },
      minRepeat: 1,
      maxRepeat: 3,
      children: [q('prix', 'integer', { required: true, constraint: '. > 0' })],
    },
  ];

  it('ajoute et supprime des occurrences', () => {
    const runtime = creer(children);
    expect(runtime.ajouterOccurrence('produits')).toBe(true);
    expect(runtime.ajouterOccurrence('produits')).toBe(true);
    expect(runtime.nombreOccurrences('produits')).toBe(2);

    expect(runtime.supprimerOccurrence('produits', 0)).toBe(true);
    expect(runtime.nombreOccurrences('produits')).toBe(1);
  });

  it('respecte le plafond', () => {
    const runtime = creer(children);
    for (let i = 0; i < 3; i += 1) runtime.ajouterOccurrence('produits');
    expect(runtime.ajouterOccurrence('produits')).toBe(false);
    expect(runtime.nombreOccurrences('produits')).toBe(3);
  });

  it('respecte le minimum', () => {
    const runtime = creer(children);
    runtime.ajouterOccurrence('produits');
    expect(runtime.supprimerOccurrence('produits', 0)).toBe(false);
  });

  it('saisit dans une occurrence précise', () => {
    const runtime = creer(children);
    runtime.ajouterOccurrence('produits');
    runtime.ajouterOccurrence('produits');

    runtime.repondre('prix', 500, { repeat: 'produits', index: 0 });
    runtime.repondre('prix', 1500, { repeat: 'produits', index: 1 });

    expect(runtime.finaliser().donnees['produits']).toEqual([
      { prix: 500 },
      { prix: 1500 },
    ]);
  });

  it('signale une violation par occurrence', () => {
    const runtime = creer(children);
    runtime.ajouterOccurrence('produits');
    runtime.ajouterOccurrence('produits');
    runtime.repondre('prix', 500, { repeat: 'produits', index: 0 });

    const violations = runtime.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.emplacement).toEqual({ repeat: 'produits', index: 1 });
  });

  it('agrège une colonne dans un calcul', () => {
    const runtime = creer([
      ...children,
      q('total', 'calculate', { calculation: 'sum(${produits.prix})' }),
    ]);
    runtime.ajouterOccurrence('produits');
    runtime.ajouterOccurrence('produits');
    runtime.repondre('prix', 500, { repeat: 'produits', index: 0 });
    runtime.repondre('prix', 1500, { repeat: 'produits', index: 1 });

    expect(runtime.lire('total')).toBe(2000);
  });

  it('ajuste les occurrences pilotées par une expression', () => {
    const runtime = creer([
      q('nombre', 'integer'),
      {
        id: 'r_produits',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 10,
        repeatCount: '${nombre}',
        children: [q('prix', 'integer')],
      },
    ]);

    runtime.repondre('nombre', 3);
    expect(runtime.nombreOccurrences('produits')).toBe(3);
  });

  it('ne supprime jamais une occurrence renseignée', () => {
    // Une réponse saisie ne disparaît pas parce qu'un nombre a changé ailleurs.
    const runtime = creer([
      q('nombre', 'integer'),
      {
        id: 'r_produits',
        name: 'produits',
        type: 'repeat',
        label: { fr: 'Produits' },
        maxRepeat: 10,
        repeatCount: '${nombre}',
        children: [q('prix', 'integer')],
      },
    ]);

    runtime.repondre('nombre', 3);
    runtime.repondre('prix', 500, { repeat: 'produits', index: 0 });
    runtime.repondre('prix', 900, { repeat: 'produits', index: 1 });
    runtime.repondre('nombre', 1);

    expect(runtime.nombreOccurrences('produits')).toBe(2);
    expect(runtime.lire('prix', { repeat: 'produits', index: 1 })).toBe(900);
  });

  it('signale une cardinalité insuffisante', () => {
    const runtime = creer(children);
    expect(runtime.violations().map((v) => v.code)).toContain('cardinalite');
  });
});

describe('pages', () => {
  const children = [
    {
      id: 'g_identite',
      name: 'identite',
      type: 'group',
      label: { fr: 'Identité' },
      appearance: 'field-list',
      children: [q('nom'), q('prenom')],
    },
    q('present'),
    {
      id: 'g_details',
      name: 'details',
      type: 'group',
      label: { fr: 'Détails' },
      appearance: 'field-list',
      relevant: "${present} = 'oui'",
      children: [q('prix', 'integer')],
    },
    q('remarque'),
  ];

  it('groupe les field-list en une page', () => {
    const pages = creer(children).pages();
    expect(pages[0]?.elements.map((e) => e.element.name)).toEqual(['nom', 'prenom']);
    expect(pages[0]?.groupe?.name).toBe('identite');
  });

  it('met les questions isolées sur leur propre page', () => {
    const pages = creer(children).pages();
    expect(pages[1]?.elements.map((e) => e.element.name)).toEqual(['present']);
  });

  it('saute une page entièrement masquée', () => {
    // Afficher un écran vide fait croire à un bug.
    const runtime = creer(children);
    runtime.repondre('present', 'non');

    expect(runtime.pageCourante()).toBe(0);
    expect(runtime.allerSuivant()).toBe(1);
    // La page « details » est masquée : on passe directement à la remarque.
    expect(runtime.allerSuivant()).toBe(3);
  });

  it('traverse la page quand elle devient pertinente', () => {
    const runtime = creer(children);
    runtime.repondre('present', 'oui');
    runtime.allerSuivant();
    expect(runtime.allerSuivant()).toBe(2);
  });

  it('revient en arrière en sautant de la même façon', () => {
    const runtime = creer(children);
    runtime.repondre('present', 'non');
    runtime.allerSuivant();
    runtime.allerSuivant();
    expect(runtime.allerPrecedent()).toBe(1);
  });

  it('rend null au bout du formulaire', () => {
    const runtime = creer([q('a')]);
    expect(runtime.allerSuivant()).toBeNull();
    expect(runtime.allerPrecedent()).toBeNull();
  });
});

describe('accord avec le validateur de soumission', () => {
  // Le runtime et le validateur ne doivent jamais diverger : ce que le premier
  // déclare complet, le second doit l'accepter sans violation.
  const document = doc([
    q('present'),
    q('prix', 'integer', {
      required: true,
      relevant: "${present} = 'oui'",
      constraint: '. > 0',
    }),
    q('total', 'calculate', { calculation: '${prix} * 2' }),
  ]);

  it('produit des données que le validateur accepte', () => {
    const runtime = RuntimeSaisie.creer(document, { now: NOW });
    runtime.repondre('present', 'oui');
    runtime.repondre('prix', 500);

    const { donnees, complet } = runtime.finaliser();
    expect(complet).toBe(true);

    const rapport = validerSoumission(document, donnees, { now: NOW });
    expect(rapport.violations).toEqual([]);
  });

  it('ne laisse pas passer une valeur non pertinente au validateur', () => {
    // C'est exactement ce que la réserve empêche.
    const runtime = RuntimeSaisie.creer(document, { now: NOW });
    runtime.repondre('present', 'oui');
    runtime.repondre('prix', 500);
    runtime.repondre('present', 'non');

    const rapport = validerSoumission(document, runtime.finaliser().donnees, { now: NOW });
    expect(rapport.violations).toEqual([]);
  });

  it('signale les mêmes manques que le validateur', () => {
    const runtime = RuntimeSaisie.creer(document, { now: NOW });
    runtime.repondre('present', 'oui');

    const { donnees, violations } = runtime.finaliser();
    const rapport = validerSoumission(document, donnees, { now: NOW });

    expect(violations.map((v) => v.name)).toEqual(['prix']);
    expect(rapport.violations.map((v) => v.name)).toEqual(['prix']);
  });
});
