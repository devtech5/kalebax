import type { Element, Question } from '@kalebax/shared';

/** Emplacement d'une réponse : à la racine, ou dans une occurrence de repeat. */
export interface Emplacement {
  readonly repeat: string;
  readonly index: number;
}

export interface ViolationSaisie {
  readonly name: string;
  readonly code: 'requise' | 'contrainte' | 'cardinalite';
  readonly message: string;
  readonly emplacement?: Emplacement | undefined;
}

/** Un élément à afficher, avec ce que l'interface doit en savoir. */
export interface ElementAffichable {
  readonly element: Element;
  readonly pertinent: boolean;
  /** Occurrence courante, pour un élément situé dans un groupe répétable. */
  readonly emplacement?: Emplacement | undefined;
}

export interface Page {
  readonly index: number;
  /** Groupe porteur de la page, absent pour une page implicite. */
  readonly groupe?: Element | undefined;
  readonly elements: readonly ElementAffichable[];
  /** Faux quand tous ses éléments sont masqués : la page est alors sautée. */
  readonly visible: boolean;
}

export interface OptionsRuntime {
  /** Réponses déjà saisies, pour reprendre un brouillon. */
  readonly donneesInitiales?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Instant figé de la saisie. Fixé à la création et jamais relu ensuite :
   * c'est ce qui garantit que le serveur aboutira au même verdict.
   */
  readonly now?: string | undefined;
}

export interface ResultatFinalisation {
  readonly donnees: Record<string, unknown>;
  readonly violations: readonly ViolationSaisie[];
  /** Vrai quand rien ne manque : l'interface peut proposer l'envoi sans réserve. */
  readonly complet: boolean;
}

export function estQuestionSaisie(element: Element): element is Question {
  return element.type !== 'group' && element.type !== 'repeat';
}
