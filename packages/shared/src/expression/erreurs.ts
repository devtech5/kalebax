/**
 * Erreurs détectées à la publication d'un formulaire.
 *
 * Voir docs/evaluateur-expressions.md §9. Toute la sévérité du langage est
 * concentrée ici : à la publication, le concepteur est devant son écran et peut
 * corriger. À l'exécution, l'évaluateur ne lève jamais rien — il produit `null`
 * et laisse un superviseur trancher (§11).
 *
 * Les messages sont rédigés pour le concepteur, en français, et jamais sous
 * forme de trace technique.
 */
export type CodeErreurExpression =
  | 'syntaxe'
  | 'fonction-inconnue'
  | 'arite-incorrecte'
  | 'reference-inconnue'
  | 'cycle'
  | 'budget-statique'
  | 'regex-risquee'
  | 'argument-non-litteral';

export interface ErreurExpression {
  readonly code: CodeErreurExpression;
  readonly message: string;
  /** Index du caractère fautif dans le texte de l'expression, à partir de 0. */
  readonly position: number;
}

export function erreur(
  code: CodeErreurExpression,
  message: string,
  position: number,
): ErreurExpression {
  return { code, message, position };
}

/**
 * Erreur de syntaxe interne au lexer et au parser.
 *
 * Elle ne sort jamais de l'analyse : `analyser()` la convertit en
 * `ErreurExpression`. Aucun appelant de la bibliothèque ne voit d'exception.
 */
export class ErreurAnalyse extends Error {
  constructor(
    override readonly message: string,
    readonly position: number,
    readonly code: CodeErreurExpression = 'syntaxe',
  ) {
    super(message);
    this.name = 'ErreurAnalyse';
  }
}
