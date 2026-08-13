export { analyser } from './expression/index.js';
export type { ExpressionCompilee, ResultatAnalyse } from './expression/index.js';

export { LIMITES_EXPRESSION } from './expression/limites.js';
export type { LimitesExpression } from './expression/limites.js';

export { reduireEnBooleen } from './expression/valeur.js';
export type { ValeurExpression, AttributBooleen } from './expression/valeur.js';

export type {
  ContexteEvaluation,
  ResultatEvaluation,
} from './expression/contexte.js';

export type {
  CodeErreurExpression,
  ErreurExpression,
} from './expression/erreurs.js';

export { construireGraphe, extraireReferences } from './expression/dependances.js';
export type { Dependance, ResultatGraphe } from './expression/dependances.js';

export type { Noeud, OperateurBinaire } from './expression/ast.js';
