import type { ValeurExpression } from './valeur.js';

/**
 * Tout ce dont l'évaluateur a besoin, et rien de plus.
 *
 * L'évaluation est une fonction pure de `(expression, contexte)` : pas
 * d'aléatoire, pas de réseau, pas de système de fichiers, pas d'horloge en
 * dehors de `now` (§7). C'est ce qui garantit qu'une expression donne le même
 * résultat sur le téléphone au moment de la saisie et sur le serveur trois
 * jours plus tard.
 */
export interface ContexteEvaluation {
  /** Réponses de la soumission, indexées par `name` de question. */
  readonly donnees: Readonly<Record<string, unknown>>;

  /**
   * Instant figé au démarrage de la saisie, en ISO 8601, transporté avec la
   * soumission. Le serveur la relit depuis `startedAt`. Deux appels à `now()`
   * dans une même saisie renvoient donc strictement la même chaîne.
   */
  readonly now: string;

  /** Valeur de la question courante, pour `.` dans `constraint` et `default`. */
  readonly valeurCourante?: ValeurExpression | undefined;

  /**
   * Occurrences de groupes répétables englobantes, de la plus extérieure à la
   * plus intérieure. La résolution d'un nom simple part de la plus interne et
   * remonte (§3.3).
   */
  readonly portees?: readonly Readonly<Record<string, unknown>>[] | undefined;

  /** Rang de l'occurrence courante, à partir de 1. `null` hors d'un `repeat`. */
  readonly position?: number | undefined;
}

/**
 * État mutable d'une évaluation : compteur d'opérations et violations
 * relevées. Il ne fuit jamais hors de `evaluer()`.
 */
export interface EtatEvaluation {
  operations: number;
  readonly violations: string[];
}

export interface ResultatEvaluation {
  readonly valeur: ValeurExpression;
  /**
   * Anomalies rencontrées pendant l'évaluation. Vide dans le cas courant. Une
   * violation n'interrompt jamais la collecte : elle est jointe à la soumission
   * pour arbitrage humain (§11).
   */
  readonly violations: readonly string[];
}
