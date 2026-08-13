import type { Noeud } from './ast.js';
import type { ContexteEvaluation, ResultatEvaluation } from './contexte.js';
import { ErreurAnalyse, erreur, type ErreurExpression } from './erreurs.js';
import { evaluer } from './evaluateur.js';
import { extraireReferences } from './dependances.js';
import { construireArbre } from './parser.js';
import { validerArbre, type OptionsValidation } from './validation.js';
import { reduireEnBooleen, type AttributBooleen, type ValeurExpression } from './valeur.js';

export interface ExpressionCompilee {
  readonly source: string;
  readonly arbre: Noeud;
  /** Noms de questions lues, pour le graphe de dépendances. */
  readonly references: readonly string[];
  evaluer(contexte: ContexteEvaluation): ResultatEvaluation;
  /** Évalue puis réduit en booléen selon les règles propres à l'attribut (§4.3). */
  evaluerBooleen(contexte: ContexteEvaluation, attribut: AttributBooleen): boolean;
}

export type ResultatAnalyse =
  | { readonly ok: true; readonly expression: ExpressionCompilee }
  | { readonly ok: false; readonly erreurs: readonly ErreurExpression[] };

/**
 * Analyse et valide une expression, sans jamais lever d'exception.
 *
 * C'est le seul point d'entrée : toute la sévérité du langage s'exerce ici, à
 * la publication, quand le concepteur est devant son écran et peut corriger. Ce
 * qui passe cette étape s'évalue ensuite sans jamais interrompre un agent.
 */
export function analyser(
  source: string,
  options: OptionsValidation = {},
): ResultatAnalyse {
  let arbre: Noeud;
  try {
    arbre = construireArbre(source);
  } catch (e) {
    if (e instanceof ErreurAnalyse) {
      return { ok: false, erreurs: [erreur(e.code, e.message, e.position)] };
    }
    throw e;
  }

  const erreurs = validerArbre(arbre, options);
  if (erreurs.length > 0) {
    return { ok: false, erreurs };
  }

  const references = extraireReferences(arbre);
  return {
    ok: true,
    expression: {
      source,
      arbre,
      references,
      evaluer: (contexte) => evaluer(arbre, contexte),
      evaluerBooleen: (contexte, attribut) =>
        reduireEnBooleen(evaluer(arbre, contexte).valeur, attribut),
    },
  };
}

export type { ValeurExpression };
