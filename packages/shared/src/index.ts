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

export { validerDocument, validerRegles, SCHEMA_DOCUMENT } from './formulaire/index.js';
export type { ResultatValidation, AnomalieDocument } from './formulaire/index.js';
export { comparerVersions } from './formulaire/versionnage.js';
export type {
  Changement,
  NatureChangement,
  RapportComparaison,
} from './formulaire/versionnage.js';
export { typeDeSaisie, verifierTypes } from './formulaire/typage.js';
export type { TypeInfere } from './formulaire/typage.js';

export { validerSoumission } from './soumission/index.js';
export type { RapportSoumission, ViolationSoumission } from './soumission/index.js';
export {
  VERSION_SCHEMA_COURANTE,
  MOTIF_NOM,
  SUFFIXE_TEXTE_LIBRE,
  datasetsReferences,
  TYPES_SAISIE,
  TYPES_SELECTION,
  TYPES_MEDIA,
  estSelection,
  estMedia,
  estQuestion,
  estGroupe,
  estRepetition,
  parcourir,
} from './formulaire/types.js';
export type {
  DocumentFormulaire,
  Element,
  Question,
  Groupe,
  Repetition,
  Option,
  SourceOptions,
  Parametres,
  Libelle,
  TypeSaisie,
  ElementSitue,
} from './formulaire/types.js';
