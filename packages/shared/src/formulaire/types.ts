/**
 * Le document de formulaire — voir docs/formulaires.md §5.
 *
 * Un formulaire est une donnée, pas du code. L'application agent est un
 * interpréteur générique : ajouter un type de question ne doit jamais exiger de
 * republier l'application sur le Play Store.
 *
 * Les noms de champs restent en anglais : c'est le format d'échange, il doit
 * correspondre exactement à ce qui est stocké dans `FormVersion.schema` et
 * rester proche de XLSForm pour que la conversion soit mécanique.
 */

/** Version du **format**, pas du formulaire. Permet à une application ancienne de refuser proprement un document trop récent. */
export const VERSION_SCHEMA_COURANTE = 1;

/** Libellé multilingue : `{ fr: "Prix unitaire", en: "Unit price" }`. */
export type Libelle = Readonly<Record<string, string>>;

/** Format d'un nom de variable — c'est le nom que verra le statisticien. */
export const MOTIF_NOM = /^[a-z_][a-z0-9_]*$/;

/** Suffixe des clés dérivées produites par une option d'échappement (§5.5). */
export const SUFFIXE_TEXTE_LIBRE = '_autre';

export const TYPES_SAISIE = [
  'text',
  'integer',
  'decimal',
  'date',
  'time',
  'datetime',
  'select_one',
  'select_multiple',
  'rank',
  'geopoint',
  'geotrace',
  'geoshape',
  'photo',
  'audio',
  'video',
  'file',
  'signature',
  'barcode',
  'calculate',
  'note',
] as const;

export type TypeSaisie = (typeof TYPES_SAISIE)[number];

export const TYPES_SELECTION = ['select_one', 'select_multiple', 'rank'] as const;
export const TYPES_MEDIA = ['photo', 'audio', 'video', 'file'] as const;

export function estSelection(type: string): boolean {
  return (TYPES_SELECTION as readonly string[]).includes(type);
}

export function estMedia(type: string): boolean {
  return (TYPES_MEDIA as readonly string[]).includes(type);
}

/* ------------------------------------------------------------------ options */

export interface Option {
  readonly value: string;
  readonly label: Libelle;
  /**
   * Option d'échappement « Autre, précisez » (§5.5). Le texte saisi est stocké
   * dans une clé dérivée `<name>_autre`, jamais mélangé à la valeur de
   * l'option : sinon le statisticien retrouve du texte libre dans une variable
   * catégorielle.
   */
  readonly allowFreeText?: boolean;
  readonly freeTextLabel?: Libelle;
}

export type SourceOptions =
  | { readonly kind: 'inline' }
  | { readonly kind: 'dataset'; readonly dataset: string }
  | {
      readonly kind: 'cascade';
      readonly dataset: string;
      /** Filtre en cascade, par exemple `region = ${region}`. */
      readonly filter: string;
    };

/* ------------------------------------------------------------------ éléments */

interface Commun {
  /** Identifiant technique stable, jamais réutilisé. Il survit aux renommages. */
  readonly id: string;
  /** Nom de la variable dans les exports, choisi par le concepteur. */
  readonly name: string;
  readonly label: Libelle;
  readonly hint?: Libelle;
  readonly relevant?: string;
  readonly appearance?: string;
  /** Verrouillage de modèle : les autres rôles ne peuvent ni modifier ni supprimer. */
  readonly locked?: boolean;
}

export interface Question extends Commun {
  readonly type: TypeSaisie;
  readonly required?: boolean | string;
  readonly constraint?: string;
  readonly constraintMessage?: Libelle;
  readonly default?: string;
  readonly readOnly?: boolean;
  /** Marque une donnée à caractère personnel : pilote l'anonymisation et la purge. */
  readonly personalData?: boolean;

  /** `select_one`, `select_multiple`, `rank`. */
  readonly optionsSource?: SourceOptions;
  readonly options?: readonly Option[];

  /** `photo`, `audio`, `video`, `file` — voir §5.6. */
  readonly minCount?: number;
  readonly maxCount?: number;

  /** `calculate` — l'expression qui produit la valeur. */
  readonly calculation?: string;
}

export interface Groupe extends Commun {
  readonly type: 'group';
  readonly children: readonly Element[];
}

export interface Repetition extends Commun {
  readonly type: 'repeat';
  readonly children: readonly Element[];
  /** Fixe, piloté par une expression, ou libre si absent. */
  readonly repeatCount?: string;
  readonly minRepeat?: number;
  /** Obligatoire : sans plafond, un formulaire sature la mémoire d'un téléphone. */
  readonly maxRepeat: number;
}

export type Element = Question | Groupe | Repetition;

export function estGroupe(element: Element): element is Groupe {
  return element.type === 'group';
}

export function estRepetition(element: Element): element is Repetition {
  return element.type === 'repeat';
}

export function estQuestion(element: Element): element is Question {
  return element.type !== 'group' && element.type !== 'repeat';
}

/* ------------------------------------------------------------------ document */

export interface Parametres {
  readonly requireStartGeopoint?: boolean;
  /** Précision en mètres au-delà de laquelle une capture est signalée insuffisante. */
  readonly minGeopointAccuracy?: number;
  readonly allowDraftSave?: boolean;
  readonly singleSubmissionPerAssignment?: boolean;
}

export interface DocumentFormulaire {
  readonly schemaVersion: number;
  readonly title: Libelle;
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  readonly settings?: Parametres;
  /** Groupes et questions, dans l'ordre d'affichage. */
  readonly children: readonly Element[];
}

/* ------------------------------------------------------------------ parcours */

/** Un élément et le chemin des groupes répétables qui l'englobent. */
export interface ElementSitue {
  readonly element: Element;
  /** Noms des `repeat` englobants, du plus extérieur au plus intérieur. */
  readonly repetitions: readonly string[];
  /** Chemin complet des noms depuis la racine, pour les messages d'erreur. */
  readonly chemin: readonly string[];
}

/** Parcourt le document en profondeur, dans l'ordre d'affichage. */
export function* parcourir(
  document: DocumentFormulaire,
): Generator<ElementSitue> {
  function* descendre(
    elements: readonly Element[],
    repetitions: readonly string[],
    chemin: readonly string[],
  ): Generator<ElementSitue> {
    for (const element of elements) {
      const cheminElement = [...chemin, element.name];
      yield { element, repetitions, chemin: cheminElement };
      if (estGroupe(element)) {
        yield* descendre(element.children, repetitions, cheminElement);
      } else if (estRepetition(element)) {
        yield* descendre(
          element.children,
          [...repetitions, element.name],
          cheminElement,
        );
      }
    }
  }
  yield* descendre(document.children, [], []);
}
