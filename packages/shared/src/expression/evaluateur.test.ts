import { describe, expect, it } from 'vitest';
import { analyser } from './index.js';
import type { ContexteEvaluation } from './contexte.js';
import { LIMITES_EXPRESSION } from './limites.js';
import type { ValeurExpression } from './valeur.js';

const NOW = '2026-08-13T03:24:00.000Z';

/** Évalue une expression et rend sa valeur. Échoue le test si l'analyse échoue. */
function evalue(
  source: string,
  donnees: Record<string, unknown> = {},
  extra: Partial<ContexteEvaluation> = {},
): ValeurExpression {
  const resultat = analyser(source);
  if (!resultat.ok) {
    throw new Error(
      `Analyse refusée pour « ${source} » : ${resultat.erreurs.map((e) => e.message).join(' / ')}`,
    );
  }
  return resultat.expression.evaluer({ donnees, now: NOW, ...extra }).valeur;
}

/** Rend les codes d'erreur d'une analyse censée échouer. */
function refus(source: string): string[] {
  const resultat = analyser(source);
  if (resultat.ok) throw new Error(`« ${source} » aurait dû être refusée`);
  return resultat.erreurs.map((e) => e.code);
}

describe('littéraux et références', () => {
  it('lit les littéraux', () => {
    expect(evalue('42')).toBe(42);
    expect(evalue('4.5')).toBe(4.5);
    expect(evalue("'texte'")).toBe('texte');
    expect(evalue('true')).toBe(true);
    expect(evalue('null')).toBe(null);
  });

  it("échappe le guillemet simple en le doublant", () => {
    expect(evalue("'l''agent'")).toBe("l'agent");
  });

  it('lit une réponse', () => {
    expect(evalue('${age}', { age: 34 })).toBe(34);
  });

  it('rend null pour une question sans réponse', () => {
    expect(evalue('${age}', {})).toBe(null);
  });

  it('distingue la chaîne vide de null', () => {
    expect(evalue("${nom} = ''", { nom: '' })).toBe(true);
    expect(evalue('${nom} = null', { nom: '' })).toBe(false);
  });

  it('rend null pour un objet, qui n\'est pas une valeur du langage', () => {
    expect(evalue('${bloc}', { bloc: { a: 1 } })).toBe(null);
  });
});

describe('précédence des opérateurs', () => {
  it('multiplie avant d\'additionner', () => {
    expect(evalue('2 + 3 * 4')).toBe(14);
  });

  it('compare après avoir calculé', () => {
    expect(evalue('2 + 3 > 4')).toBe(true);
  });

  it('applique and avant or', () => {
    expect(evalue('true or true and false')).toBe(true);
  });

  it('respecte les parenthèses', () => {
    expect(evalue('(2 + 3) * 4')).toBe(20);
    expect(evalue('(true or true) and false')).toBe(false);
  });

  it('associe à gauche', () => {
    expect(evalue('10 - 3 - 2')).toBe(5);
    expect(evalue('100 / 10 / 2')).toBe(5);
  });

  it('applique le moins unaire avant la multiplication', () => {
    expect(evalue('-2 * 3')).toBe(-6);
    expect(evalue('- ${x}', { x: 5 })).toBe(-5);
  });
});

describe('valeurs manquantes', () => {
  it('propage null dans l\'arithmétique', () => {
    expect(evalue('${absent} + 5')).toBe(null);
    expect(evalue('${absent} * 5')).toBe(null);
  });

  it('rend null pour une comparaison d\'ordre avec null', () => {
    expect(evalue('${absent} < 5')).toBe(null);
    expect(evalue('${absent} >= 5')).toBe(null);
  });

  it('compare null par égalité', () => {
    expect(evalue('null = null')).toBe(true);
    expect(evalue("${absent} = 'oui'")).toBe(false);
    expect(evalue("${absent} != 'oui'")).toBe(true);
  });

  it('applique la logique à trois valeurs', () => {
    expect(evalue('false and null')).toBe(false);
    expect(evalue('true and null')).toBe(null);
    expect(evalue('true or null')).toBe(true);
    expect(evalue('false or null')).toBe(null);
    expect(evalue('null and null')).toBe(null);
  });
});

describe('réduction en booléen — la règle qui protège l\'agent', () => {
  const contexte: ContexteEvaluation = { donnees: {}, now: NOW };

  function booleen(source: string, attribut: 'relevant' | 'constraint'): boolean {
    const resultat = analyser(source);
    if (!resultat.ok) throw new Error('analyse refusée');
    return resultat.expression.evaluerBooleen(contexte, attribut);
  }

  it('masque une question dont le relevant est indécidable', () => {
    expect(booleen('${absent} > 5', 'relevant')).toBe(false);
  });

  it('accepte une saisie dont la contrainte est indécidable', () => {
    expect(booleen('${absent} > 5', 'constraint')).toBe(true);
  });
});

describe('absence de conversion implicite', () => {
  it('refuse d\'additionner une chaîne et un nombre', () => {
    expect(evalue("'12' + 3")).toBe(null);
  });

  it('ne concatène pas avec +', () => {
    expect(evalue("'a' + 'b'")).toBe(null);
  });

  it('ne compare pas une chaîne et un nombre', () => {
    expect(evalue("'12' < 30")).toBe(null);
  });

  it('convertit explicitement', () => {
    expect(evalue("number('12') + 3")).toBe(15);
    expect(evalue("concat('a', 'b')")).toBe('ab');
  });

  it('ne traite aucune valeur non booléenne comme vraie', () => {
    expect(evalue('1 and true')).toBe(null);
    expect(evalue("not('oui')")).toBe(null);
  });
});

describe('arithmétique — cas frontières', () => {
  it('rend null pour une division par zéro', () => {
    expect(evalue('5 / 0')).toBe(null);
    expect(evalue('0 / 0')).toBe(null);
    expect(evalue('5 mod 0')).toBe(null);
  });

  it('fait suivre au reste le signe du dividende', () => {
    expect(evalue('-7 mod 3')).toBe(-1);
    expect(evalue('7 mod -3')).toBe(1);
  });

  it('arrondit au plus proche, moitié vers le haut', () => {
    expect(evalue('round(2.5)')).toBe(3);
    expect(evalue('round(-2.5)')).toBe(-2);
    expect(evalue('round(2.4)')).toBe(2);
    expect(evalue('round(3.14159, 2)')).toBe(3.14);
  });

  it('tronque vers zéro avec int', () => {
    expect(evalue('int(2.7)')).toBe(2);
    expect(evalue('int(-2.7)')).toBe(-2);
  });
});

describe('fonctions de sélection', () => {
  const donnees = { langues: ['fr', 'dioula'], region: 'abidjan' };

  it('teste l\'appartenance dans une sélection multiple', () => {
    expect(evalue("selected(${langues}, 'fr')", donnees)).toBe(true);
    expect(evalue("selected(${langues}, 'baoule')", donnees)).toBe(false);
  });

  it('teste l\'égalité pour une sélection simple', () => {
    expect(evalue("selected(${region}, 'abidjan')", donnees)).toBe(true);
  });

  it('rend false, et non null, sur une absence de réponse', () => {
    // Une case non cochée est une réponse, pas une absence de réponse.
    expect(evalue("selected(${absent}, 'fr')")).toBe(false);
    expect(evalue('count-selected(${absent})')).toBe(0);
  });

  it('compte les éléments sélectionnés', () => {
    expect(evalue('count-selected(${langues})', donnees)).toBe(2);
  });
});

describe('groupes répétables', () => {
  const donnees = {
    produits: [{ prix: 500 }, { prix: 1500 }, { prix: null }],
  };

  it('agrège une colonne depuis l\'extérieur', () => {
    expect(evalue('sum(${produits.prix})', donnees)).toBe(2000);
    expect(evalue('count(${produits})', donnees)).toBe(3);
    expect(evalue('min(${produits.prix})', donnees)).toBe(500);
    expect(evalue('max(${produits.prix})', donnees)).toBe(1500);
  });

  it('ignore les occurrences non remplies dans sum', () => {
    // sum ignore les null là où + les propage : une colonne partiellement
    // remplie est normale dans un groupe répétable.
    expect(evalue('sum(${produits.prix})', donnees)).toBe(2000);
  });

  it('rend 0 pour un agrégat vide et null pour un extremum vide', () => {
    expect(evalue('sum(${produits.prix})', { produits: [] })).toBe(0);
    expect(evalue('min(${produits.prix})', { produits: [] })).toBe(null);
  });

  it('lit l\'occurrence courante depuis l\'intérieur', () => {
    expect(
      evalue('${prix} * 2', donnees, { portees: [{ prix: 750 }] }),
    ).toBe(1500);
  });

  it('remonte au parent quand le nom est absent de l\'occurrence', () => {
    expect(
      evalue('${taux}', { taux: 18 }, { portees: [{ prix: 750 }] }),
    ).toBe(18);
  });

  it('donne le rang de l\'occurrence courante', () => {
    expect(evalue('position()', {}, { position: 3 })).toBe(3);
    expect(evalue('position()')).toBe(null);
  });
});

describe('chaînes', () => {
  it('compte en points de code Unicode', () => {
    expect(evalue("string-length('éàü')")).toBe(3);
    expect(evalue("string-length('abc')")).toBe(3);
    expect(evalue('string-length(${absent})')).toBe(0);
  });

  it('extrait une sous-chaîne, indices hors bornes tronqués', () => {
    expect(evalue("substr('abidjan', 0, 3)")).toBe('abi');
    expect(evalue("substr('abidjan', 3)")).toBe('djan');
    expect(evalue("substr('abidjan', 5, 99)")).toBe('an');
    expect(evalue("substr('abidjan', 9, 12)")).toBe('');
  });

  it('concatène en traitant null comme une chaîne vide', () => {
    expect(evalue("concat('a', ${absent}, 'b')")).toBe('ab');
    expect(evalue("concat('n° ', 3)")).toBe('n° 3');
  });

  it('teste une expression régulière en correspondance partielle', () => {
    expect(evalue("regex('CI-2026-001', '\\d{4}')")).toBe(true);
    expect(evalue("regex('abc', '^\\d+$')")).toBe(false);
    expect(evalue("regex(${absent}, '.')")).toBe(false);
  });

  it('transmet la barre oblique inverse telle quelle', () => {
    // Le langage n'échappe que le guillemet simple : un motif de regex s'écrit
    // donc naturellement, sans doubler les barres obliques inverses.
    expect(evalue("string-length('\\d')")).toBe(2);
  });
});

describe('dates', () => {
  it('fige today() et now() sur l\'instant de démarrage', () => {
    expect(evalue('today()')).toBe('2026-08-13');
    expect(evalue('now()')).toBe(NOW);
  });

  it('donne la même valeur à deux appels dans une même saisie', () => {
    expect(evalue('now() = now()')).toBe(true);
  });

  it('calcule une différence de dates', () => {
    expect(evalue("date-diff('2026-08-01', '2026-08-13', 'jours')")).toBe(12);
    expect(evalue("date-diff('2026-08-13', '2026-08-01', 'jours')")).toBe(-12);
    expect(evalue("date-diff('2026-01-15', '2026-08-13', 'mois')")).toBe(6);
    expect(evalue("date-diff('2000-08-13', '2026-08-13', 'annees')")).toBe(26);
  });

  it('refuse une date qui n\'est pas au format ISO 8601', () => {
    expect(evalue("date-diff('13/08/2026', '2026-08-13', 'jours')")).toBe(null);
    expect(evalue("date-diff('2026-02-31', '2026-08-13', 'jours')")).toBe(null);
  });

  it('compare des dates ISO lexicographiquement', () => {
    expect(evalue("${d} < '2026-01-01'", { d: '2025-12-31' })).toBe(true);
  });
});

describe('if et coalesce', () => {
  it('choisit une branche', () => {
    expect(evalue("if(${a} = 1, 'oui', 'non')", { a: 1 })).toBe('oui');
    expect(evalue("if(${a} = 1, 'oui', 'non')", { a: 2 })).toBe('non');
  });

  it('prend la branche fausse quand la condition est indécidable', () => {
    expect(evalue("if(${absent} = 1, 'oui', 'non')", {})).toBe('non');
  });

  it('rend la première valeur renseignée', () => {
    expect(evalue('coalesce(${absent}, ${b}, 0)', { b: 7 })).toBe(7);
    expect(evalue('coalesce(${absent}, ${autre})')).toBe(null);
  });
});

describe('refus à la publication', () => {
  it('refuse une syntaxe invalide', () => {
    expect(refus('2 +')).toContain('syntaxe');
    expect(refus('(2 + 3')).toContain('syntaxe');
    expect(refus("'chaine")).toContain('syntaxe');
    expect(refus('${')).toContain('syntaxe');
  });

  it('guide vers la bonne écriture des opérateurs', () => {
    expect(refus('${a} == 1')).toContain('syntaxe');
    expect(refus('${a} && ${b}')).toContain('syntaxe');
    expect(refus('"texte"')).toContain('syntaxe');
  });

  it('refuse une fonction inconnue', () => {
    expect(refus('inexistante(1)')).toContain('fonction-inconnue');
  });

  it('refuse une arité incorrecte', () => {
    expect(refus('round()')).toContain('arite-incorrecte');
    expect(refus("substr('a')")).toContain('arite-incorrecte');
    expect(refus('today(1)')).toContain('arite-incorrecte');
  });

  it('refuse une référence à une question inexistante', () => {
    const resultat = analyser('${inconnue} = 1', {
      nomsConnus: new Set(['age']),
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      expect(resultat.erreurs[0]?.code).toBe('reference-inconnue');
    }
  });

  it('accepte une référence connue', () => {
    expect(analyser('${age} = 1', { nomsConnus: new Set(['age']) }).ok).toBe(true);
  });

  it('situe l\'erreur dans le texte', () => {
    const resultat = analyser('1 + inexistante(2)');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      expect(resultat.erreurs[0]?.position).toBe(4);
    }
  });
});

describe('expressions malveillantes', () => {
  it('refuse une expression trop longue', () => {
    expect(refus('1 + '.repeat(3000) + '1')).toContain('budget-statique');
  });

  it('refuse une imbrication trop profonde', () => {
    const source = '('.repeat(100) + '1' + ')'.repeat(100);
    expect(refus(source)).toContain('budget-statique');
  });

  it('refuse un motif de regex à explosion combinatoire', () => {
    expect(refus("regex('a', '(a+)+')")).toContain('regex-risquee');
    expect(refus("regex('a', '(a|a)*')")).toContain('regex-risquee');
    expect(refus("regex('a', '(a)\\1')")).toContain('regex-risquee');
  });

  it('accepte un motif ordinaire', () => {
    expect(analyser("regex('a', '^[A-Z]{2}-\\d{4}$')").ok).toBe(true);
    // Une alternance non répétée est courante et sans danger.
    expect(analyser("regex('a', '^(abidjan|bouake)$')").ok).toBe(true);
  });

  it('refuse un motif de regex calculé', () => {
    expect(refus('regex(${a}, ${b})')).toContain('argument-non-litteral');
  });

  it('borne une évaluation sur un très grand groupe répétable', () => {
    const produits = Array.from({ length: 10_000 }, (_, i) => ({ prix: i }));
    const resultat = analyser('sum(${produits.prix})');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      const sortie = resultat.expression.evaluer({ donnees: { produits }, now: NOW });
      expect(sortie.valeur).toBe(49_995_000);
      expect(sortie.violations).toHaveLength(0);
    }
  });

  it('refuse une expression comptant trop d\'éléments', () => {
    const source = Array.from({ length: 400 }, (_, i) => String(i)).join(' + ');
    expect(refus(source)).toContain('budget-statique');
  });

  it('borne le nombre d\'opérations par le nombre de nœuds', () => {
    // Chaque nœud compte pour une opération, et le budget statique plafonne les
    // nœuds bien en dessous du budget d'exécution : aucune expression publiable
    // ne peut donc l'atteindre. Le compteur d'opérations reste une défense en
    // profondeur, pas un mécanisme de tous les jours.
    expect(LIMITES_EXPRESSION.nombreNoeuds).toBeLessThan(
      LIMITES_EXPRESSION.operationsParEvaluation,
    );
  });
});

describe('robustesse', () => {
  it('ne lève jamais sur des données aberrantes', () => {
    const resultat = analyser('${a} + ${b} * count(${c})');
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    const aberrantes: Record<string, unknown>[] = [
      { a: {}, b: [], c: 'texte' },
      { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: null },
      { a: () => 1, b: Symbol('x'), c: undefined },
    ];
    for (const donnees of aberrantes) {
      expect(() => resultat.expression.evaluer({ donnees, now: NOW })).not.toThrow();
    }
  });
});
