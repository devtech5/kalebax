/**
 * Les cinq types de valeurs manipulés par l'évaluateur, et rien d'autre.
 *
 * Voir docs/evaluateur-expressions.md §2. Une date n'est pas un type distinct :
 * c'est une chaîne ISO 8601, exactement telle qu'elle est stockée dans les
 * données d'une soumission.
 *
 * `null` représente indifféremment une question non répondue, une question
 * rendue non pertinente, ou le résultat d'une opération invalide. L'évaluateur
 * ne lève jamais d'exception à l'exécution : il produit `null` (§11).
 */
export type ValeurExpression =
  | null
  | boolean
  | number
  | string
  | readonly ValeurExpression[];

/**
 * Réduction d'un résultat d'expression en booléen.
 *
 * Chaque attribut résout `null` dans le sens qui ne bloque jamais la personne
 * qui collecte (§4.3) : un `relevant` indécidable masque la question, mais une
 * `constraint` indécidable accepte la saisie. L'asymétrie est volontaire.
 */
export type AttributBooleen = 'relevant' | 'constraint' | 'required' | 'filter';

const VALEUR_SI_NULL: Readonly<Record<AttributBooleen, boolean>> = {
  relevant: false,
  constraint: true,
  required: false,
  filter: false,
};

export function reduireEnBooleen(
  valeur: ValeurExpression,
  attribut: AttributBooleen,
): boolean {
  if (valeur === null) return VALEUR_SI_NULL[attribut];
  return valeur === true;
}
