import type { Noeud, OperateurBinaire } from './ast.js';
import type {
  ContexteEvaluation,
  EtatEvaluation,
  ResultatEvaluation,
} from './contexte.js';
import { FONCTIONS } from './fonctions.js';
import { LIMITES_EXPRESSION } from './limites.js';
import type { ValeurExpression } from './valeur.js';

/** Marqueur interne de dépassement de budget, jamais retourné à l'appelant. */
const BUDGET_DEPASSE = Symbol('budget-depasse');

type Intermediaire = ValeurExpression | typeof BUDGET_DEPASSE;

/**
 * Convertit une valeur venue des données brutes en valeur d'expression.
 *
 * `undefined` devient `null`, et tout ce qui n'est pas un des cinq types du
 * langage (§2) — un objet, une fonction, une date JavaScript — devient `null`
 * plutôt que de circuler sous une forme que l'évaluateur ne sait pas comparer.
 */
function normaliser(brut: unknown): ValeurExpression {
  if (brut === null || brut === undefined) return null;
  const type = typeof brut;
  if (type === 'boolean' || type === 'string') return brut as boolean | string;
  if (type === 'number') return Number.isFinite(brut) ? (brut as number) : null;
  if (Array.isArray(brut)) return brut.map(normaliser);
  return null;
}

/** Descend d'un segment de chemin, en projetant sur chaque occurrence d'un repeat. */
function projeter(valeur: unknown, segment: string): unknown {
  if (valeur === null || valeur === undefined) return null;
  if (Array.isArray(valeur)) return valeur.map((e) => projeter(e, segment));
  if (typeof valeur === 'object') {
    return (valeur as Record<string, unknown>)[segment] ?? null;
  }
  return null;
}

/**
 * Résout `${nom}` ou `${groupe.champ}`.
 *
 * Un nom simple part de la portée la plus interne et remonte : à l'intérieur
 * d'un groupe répétable, il désigne l'occurrence courante. Un chemin composé
 * part de la racine et produit le tableau de toutes les occurrences (§3.3).
 */
function resoudre(
  chemin: readonly string[],
  contexte: ContexteEvaluation,
): ValeurExpression {
  const premier = chemin[0];
  if (premier === undefined) return null;

  if (chemin.length === 1) {
    const portees = contexte.portees ?? [];
    for (let i = portees.length - 1; i >= 0; i -= 1) {
      const portee = portees[i];
      if (portee !== undefined && Object.hasOwn(portee, premier)) {
        return normaliser(portee[premier]);
      }
    }
    return normaliser(contexte.donnees[premier]);
  }

  let courant: unknown = contexte.donnees;
  for (const segment of chemin) {
    courant = projeter(courant, segment);
  }
  return normaliser(courant);
}

/* ------------------------------------------------------------- opérateurs */

function comparerEgalite(gauche: ValeurExpression, droite: ValeurExpression): boolean {
  if (Array.isArray(gauche) || Array.isArray(droite)) {
    if (!Array.isArray(gauche) || !Array.isArray(droite)) return false;
    if (gauche.length !== droite.length) return false;
    return gauche.every((v, i) => comparerEgalite(v, droite[i] ?? null));
  }
  return gauche === droite;
}

/**
 * Logique à trois valeurs (§4.2) : `false and inconnu` vaut `false`, mais
 * `true and inconnu` reste `inconnu`.
 */
function et(gauche: ValeurExpression, droite: ValeurExpression): ValeurExpression {
  if (gauche === false || droite === false) return false;
  if (gauche === null || droite === null) return null;
  if (gauche === true && droite === true) return true;
  return null;
}

function ou(gauche: ValeurExpression, droite: ValeurExpression): ValeurExpression {
  if (gauche === true || droite === true) return true;
  if (gauche === null || droite === null) return null;
  if (gauche === false && droite === false) return false;
  return null;
}

function arithmetique(
  operateur: '+' | '-' | '*' | '/' | 'mod',
  gauche: ValeurExpression,
  droite: ValeurExpression,
): ValeurExpression {
  // Aucune conversion implicite : '12' + 3 vaut null, pas 15 ni '123' (§5).
  if (typeof gauche !== 'number' || typeof droite !== 'number') return null;

  let resultat: number;
  switch (operateur) {
    case '+':
      resultat = gauche + droite;
      break;
    case '-':
      resultat = gauche - droite;
      break;
    case '*':
      resultat = gauche * droite;
      break;
    case '/':
      if (droite === 0) return null;
      resultat = gauche / droite;
      break;
    case 'mod':
      // Le reste suit le signe du dividende : -7 mod 3 vaut -1 (§6.3).
      if (droite === 0) return null;
      resultat = gauche % droite;
      break;
  }
  return Number.isFinite(resultat) ? resultat : null;
}

function ordre(
  operateur: '<' | '<=' | '>' | '>=',
  gauche: ValeurExpression,
  droite: ValeurExpression,
): ValeurExpression {
  // Une question vide n'est ni plus grande ni plus petite que quoi que ce soit.
  if (gauche === null || droite === null) return null;

  const comparable =
    (typeof gauche === 'number' && typeof droite === 'number') ||
    // Les dates ISO 8601 se comparent lexicographiquement, ce qui coïncide avec
    // l'ordre chronologique pour ce format (§5).
    (typeof gauche === 'string' && typeof droite === 'string');
  if (!comparable) return null;

  switch (operateur) {
    case '<':
      return gauche < droite;
    case '<=':
      return gauche <= droite;
    case '>':
      return gauche > droite;
    case '>=':
      return gauche >= droite;
  }
}

function appliquerBinaire(
  operateur: OperateurBinaire,
  gauche: ValeurExpression,
  droite: ValeurExpression,
): ValeurExpression {
  switch (operateur) {
    case 'et':
      return et(gauche, droite);
    case 'ou':
      return ou(gauche, droite);
    case '=':
      return comparerEgalite(gauche, droite);
    case '!=':
      return !comparerEgalite(gauche, droite);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return ordre(operateur, gauche, droite);
    case '+':
    case '-':
    case '*':
    case '/':
    case 'mod':
      return arithmetique(operateur, gauche, droite);
  }
}

/* ------------------------------------------------------------- évaluation */

function evaluerNoeud(
  noeud: Noeud,
  contexte: ContexteEvaluation,
  etat: EtatEvaluation,
): Intermediaire {
  etat.operations += 1;
  if (etat.operations > LIMITES_EXPRESSION.operationsParEvaluation) {
    return BUDGET_DEPASSE;
  }

  switch (noeud.type) {
    case 'litteral':
      return noeud.valeur;

    case 'reference':
      return resoudre(noeud.chemin, contexte);

    case 'courant':
      return contexte.valeurCourante ?? null;

    case 'unaire': {
      const operande = evaluerNoeud(noeud.operande, contexte, etat);
      if (operande === BUDGET_DEPASSE) return BUDGET_DEPASSE;
      return typeof operande === 'number' ? -operande : null;
    }

    case 'binaire': {
      const gauche = evaluerNoeud(noeud.gauche, contexte, etat);
      if (gauche === BUDGET_DEPASSE) return BUDGET_DEPASSE;
      const droite = evaluerNoeud(noeud.droite, contexte, etat);
      if (droite === BUDGET_DEPASSE) return BUDGET_DEPASSE;
      return appliquerBinaire(noeud.operateur, gauche, droite);
    }

    case 'appel': {
      const definition = FONCTIONS[noeud.nom];
      // Une fonction inconnue est refusée à la publication ; si elle arrive
      // jusqu'ici, on ne bloque pas la collecte pour autant.
      if (definition === undefined) {
        etat.violations.push(`Fonction inconnue : ${noeud.nom}()`);
        return null;
      }
      const args: ValeurExpression[] = [];
      for (const argument of noeud.arguments) {
        const valeur = evaluerNoeud(argument, contexte, etat);
        if (valeur === BUDGET_DEPASSE) return BUDGET_DEPASSE;
        args.push(valeur);
      }
      return definition.appliquer(args, contexte);
    }
  }
}

/**
 * Évalue un arbre. Ne lève jamais d'exception : toute anomalie donne `null` et
 * une entrée dans `violations` (§11).
 */
export function evaluer(
  noeud: Noeud,
  contexte: ContexteEvaluation,
): ResultatEvaluation {
  const etat: EtatEvaluation = { operations: 0, violations: [] };
  const valeur = evaluerNoeud(noeud, contexte, etat);

  if (valeur === BUDGET_DEPASSE) {
    etat.violations.push(
      `Expression interrompue : plus de ${LIMITES_EXPRESSION.operationsParEvaluation} opérations élémentaires.`,
    );
    return { valeur: null, violations: etat.violations };
  }

  return { valeur, violations: etat.violations };
}
