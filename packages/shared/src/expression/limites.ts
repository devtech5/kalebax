/**
 * Budget d'exécution de l'évaluateur d'expressions.
 *
 * Voir docs/evaluateur-expressions.md §8. Ces bornes existent pour qu'une
 * expression pathologique ne fige jamais l'application d'un agent sur un
 * appareil d'entrée de gamme, et pour qu'un document de formulaire — donnée
 * fournie par un utilisateur, évaluée côté serveur à chaque soumission — ne
 * puisse pas servir de vecteur de déni de service.
 *
 * Les quatre premières sont vérifiées à la publication (statiquement), la
 * cinquième à l'exécution : elle dépend de la taille réelle des groupes
 * répétables.
 */
export const LIMITES_EXPRESSION = {
  /** Longueur du texte de l'expression, en caractères. */
  longueurTexte: 2_000,
  /** Profondeur maximale de l'arbre syntaxique. */
  profondeurArbre: 32,
  /** Nombre maximal de nœuds dans l'arbre syntaxique. */
  nombreNoeuds: 500,
  /** Longueur maximale d'un motif d'expression régulière. */
  longueurMotifRegex: 200,
  /** Opérations élémentaires autorisées pour une évaluation. */
  operationsParEvaluation: 10_000,
} as const;

export type LimitesExpression = typeof LIMITES_EXPRESSION;
