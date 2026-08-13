import type { ContexteEvaluation } from '../expression/contexte.js';
import { analyser } from '../expression/index.js';
import {
  estGroupe,
  estQuestion,
  estRepetition,
  SUFFIXE_TEXTE_LIBRE,
  type DocumentFormulaire,
  type Element,
  type Question,
} from '../formulaire/types.js';

/**
 * Revalidation d'une soumission à la réception — docs/formulaires.md §8.
 *
 * Le serveur ne fait jamais confiance au client, mais il doit aboutir au même
 * verdict que lui : c'est le même évaluateur qui tourne des deux côtés, avec le
 * même instant figé.
 *
 * **Rien n'est jamais rejeté au sens de « perdu ».** Une soumission qui viole
 * une règle métier est enregistrée quand même, avec le détail des violations :
 * perdre une donnée de terrain parce qu'elle ne passe pas une contrainte est
 * pire que la conserver pour arbitrage humain. Un superviseur tranche depuis la
 * console.
 */

export interface ViolationSoumission {
  readonly code: string;
  readonly message: string;
  /** Nom de la question concernée. */
  readonly name: string;
  /** Chemin dans les données, avec les rangs d'occurrence : `produits[2].prix`. */
  readonly chemin: string;
}

export interface RapportSoumission {
  /** Faux dès la première violation : la soumission sera enregistrée en `rejected`. */
  readonly valide: boolean;
  readonly violations: readonly ViolationSoumission[];
  /**
   * Clés reçues qui ne correspondent à aucune question. Elles sont
   * **conservées** plutôt que rejetées — une donnée collectée par un agent ne
   * se jette pas — et rangées dans `Submission.extraData`.
   */
  readonly extraData: Readonly<Record<string, unknown>>;
}

const MOTIF_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MOTIF_HEURE = /^\d{2}:\d{2}(:\d{2})?$/;
const MOTIF_DATE_HEURE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function estVide(valeur: unknown): boolean {
  if (valeur === null || valeur === undefined) return true;
  if (typeof valeur === 'string') return valeur.trim() === '';
  if (Array.isArray(valeur)) return valeur.length === 0;
  return false;
}

export interface OptionsValidationSoumission {
  /** Instant figé au démarrage de la saisie, transporté avec la soumission. */
  readonly now: string;
  /**
   * Valeurs acceptables des jeux de données référencés, par nom.
   *
   * Absent côté appareil — le référentiel y est déjà filtré par l'interface,
   * qui ne propose que des options existantes. Fourni côté serveur, qui a le
   * document et les référentiels.
   */
  readonly valeursDataset?: Readonly<Record<string, ReadonlySet<string>>> | undefined;
}

export function validerSoumission(
  document: DocumentFormulaire,
  donnees: Readonly<Record<string, unknown>>,
  options: OptionsValidationSoumission,
): RapportSoumission {
  const violations: ViolationSoumission[] = [];
  const extraData: Record<string, unknown> = {};

  const signaler = (
    code: string,
    message: string,
    name: string,
    chemin: string,
  ): void => {
    violations.push({ code, message, name, chemin });
  };

  /**
   * Un `group` n'introduit pas de niveau dans les données : ses questions sont
   * à plat. Seul un `repeat` produit un tableau d'objets.
   */
  const validerNiveau = (
    elements: readonly Element[],
    niveau: Readonly<Record<string, unknown>>,
    portees: readonly Readonly<Record<string, unknown>>[],
    prefixe: string,
    position: number | undefined,
    attendus: Set<string>,
  ): void => {
    for (const element of elements) {
      attendus.add(element.name);
      const chemin = prefixe === '' ? element.name : `${prefixe}.${element.name}`;

      const contexte: ContexteEvaluation = {
        donnees,
        now: options.now,
        portees,
        position,
        valeurCourante: null,
      };

      const pertinent = evaluerPertinence(element, contexte);

      if (estGroupe(element)) {
        if (pertinent) {
          validerNiveau(element.children, niveau, portees, prefixe, position, attendus);
        }
        continue;
      }

      if (estRepetition(element)) {
        const brut = niveau[element.name];

        if (!pertinent) {
          if (!estVide(brut)) {
            signaler(
              'valeur-non-pertinente',
              `« ${element.name} » n'est pas pertinent d'après les réponses données, mais contient des occurrences.`,
              element.name,
              chemin,
            );
          }
          continue;
        }

        if (brut === undefined || brut === null) continue;
        if (!Array.isArray(brut)) {
          signaler(
            'type-invalide',
            `« ${element.name} » est un groupe répétable et attend une liste d'occurrences.`,
            element.name,
            chemin,
          );
          continue;
        }

        if (brut.length > element.maxRepeat) {
          signaler(
            'cardinalite-depassee',
            `« ${element.name} » compte ${brut.length} occurrences pour un maximum de ${element.maxRepeat}.`,
            element.name,
            chemin,
          );
        }
        if (element.minRepeat !== undefined && brut.length < element.minRepeat) {
          signaler(
            'cardinalite-insuffisante',
            `« ${element.name} » compte ${brut.length} occurrences pour un minimum de ${element.minRepeat}.`,
            element.name,
            chemin,
          );
        }

        brut.forEach((occurrence, index) => {
          if (typeof occurrence !== 'object' || occurrence === null || Array.isArray(occurrence)) {
            signaler(
              'type-invalide',
              `L'occurrence ${index + 1} de « ${element.name} » n'est pas un ensemble de réponses.`,
              element.name,
              `${chemin}[${index}]`,
            );
            return;
          }
          const contenu = occurrence as Record<string, unknown>;
          const attendusOccurrence = new Set<string>();
          validerNiveau(
            element.children,
            contenu,
            [...portees, contenu],
            `${chemin}[${index}]`,
            index + 1,
            attendusOccurrence,
          );
          collecterInconnues(contenu, attendusOccurrence, `${chemin}[${index}]`, extraData);
        });
        continue;
      }

      if (!estQuestion(element)) continue;

      const valeur = niveau[element.name];

      // Une question rendue non pertinente doit être vide : sinon la donnée
      // contredit la logique du formulaire.
      if (!pertinent) {
        if (!estVide(valeur)) {
          signaler(
            'valeur-non-pertinente',
            `« ${element.name} » n'est pas pertinente d'après les réponses données, mais porte une valeur.`,
            element.name,
            chemin,
          );
        }
        continue;
      }

      validerQuestion(
        element,
        valeur,
        chemin,
        contexte,
        signaler,
        attendus,
        options.valeursDataset,
      );
    }
  };

  const attendusRacine = new Set<string>();
  validerNiveau(document.children, donnees, [], '', undefined, attendusRacine);
  collecterInconnues(donnees, attendusRacine, '', extraData);

  return { valide: violations.length === 0, violations, extraData };
}

function evaluerPertinence(element: Element, contexte: ContexteEvaluation): boolean {
  if (element.relevant === undefined) return true;
  const resultat = analyser(element.relevant);
  // Une expression invalide a été refusée à la publication ; si elle arrive
  // ici, on n'affiche pas la question plutôt que de bloquer la réception.
  if (!resultat.ok) return false;
  return resultat.expression.evaluerBooleen(contexte, 'relevant');
}

function collecterInconnues(
  niveau: Readonly<Record<string, unknown>>,
  attendus: ReadonlySet<string>,
  prefixe: string,
  extraData: Record<string, unknown>,
): void {
  // Les clés dérivées d'options libres ont été ajoutées à `attendus` par
  // `validerOptions`, et seulement quand l'option retenue autorise vraiment la
  // saisie libre. Une clé « _autre » qui arrive sans cela est bien une donnée
  // inattendue : on la conserve, sans la traiter comme une réponse.
  for (const [cle, valeur] of Object.entries(niveau)) {
    if (attendus.has(cle)) continue;
    extraData[prefixe === '' ? cle : `${prefixe}.${cle}`] = valeur;
  }
}

function validerQuestion(
  question: Question,
  valeur: unknown,
  chemin: string,
  contexte: ContexteEvaluation,
  signaler: (code: string, message: string, name: string, chemin: string) => void,
  attendus: Set<string>,
  valeursDataset?: Readonly<Record<string, ReadonlySet<string>>> | undefined,
): void {
  const { name, type } = question;

  // Un champ calculé est dérivé, jamais saisi : sa valeur n'est pas une donnée
  // à valider mais un résultat, recalculable à tout moment depuis le reste.
  if (type === 'calculate' || type === 'note') return;

  if (estVide(valeur)) {
    if (estObligatoire(question, contexte)) {
      signaler(
        'reponse-manquante',
        `« ${name} » est obligatoire mais n'a pas de réponse.`,
        name,
        chemin,
      );
    }
    return;
  }

  if (!typeConforme(question, valeur)) {
    signaler(
      'type-invalide',
      `La valeur de « ${name} » ne correspond pas au type ${type}.`,
      name,
      chemin,
    );
    return;
  }

  validerOptions(question, valeur, chemin, signaler, attendus, valeursDataset);
  validerCardinaliteMedia(question, valeur, chemin, signaler);
  validerContrainte(question, valeur, chemin, contexte, signaler);
}

function estObligatoire(question: Question, contexte: ContexteEvaluation): boolean {
  const { required } = question;
  if (required === undefined || required === false) return false;
  if (required === true) return true;
  const resultat = analyser(required);
  if (!resultat.ok) return false;
  return resultat.expression.evaluerBooleen(contexte, 'required');
}

function typeConforme(question: Question, valeur: unknown): boolean {
  switch (question.type) {
    case 'text':
    case 'barcode':
    case 'select_one':
    case 'signature':
      return typeof valeur === 'string';
    case 'integer':
      return typeof valeur === 'number' && Number.isInteger(valeur);
    case 'decimal':
      return typeof valeur === 'number' && Number.isFinite(valeur);
    case 'date':
      return typeof valeur === 'string' && MOTIF_DATE.test(valeur);
    case 'time':
      return typeof valeur === 'string' && MOTIF_HEURE.test(valeur);
    case 'datetime':
      return typeof valeur === 'string' && MOTIF_DATE_HEURE.test(valeur);
    case 'select_multiple':
    case 'rank':
      return Array.isArray(valeur) && valeur.every((v) => typeof v === 'string');
    case 'photo':
    case 'audio':
    case 'video':
    case 'file':
      return Array.isArray(valeur) && valeur.every((v) => typeof v === 'string');
    case 'geopoint':
      return estGeopoint(valeur);
    case 'geotrace':
    case 'geoshape':
      return Array.isArray(valeur) && valeur.every(estGeopoint);
    default:
      return true;
  }
}

function estGeopoint(valeur: unknown): boolean {
  if (typeof valeur !== 'object' || valeur === null || Array.isArray(valeur)) return false;
  const point = valeur as Record<string, unknown>;
  return typeof point['lat'] === 'number' && typeof point['lng'] === 'number';
}

function validerOptions(
  question: Question,
  valeur: unknown,
  chemin: string,
  signaler: (code: string, message: string, name: string, chemin: string) => void,
  attendus: Set<string>,
  valeursDataset?: Readonly<Record<string, ReadonlySet<string>>> | undefined,
): void {
  const source = question.optionsSource;

  // Les options d'un jeu de données ne sont pas dans le document. Elles ne sont
  // vérifiées que si l'appelant a fourni le référentiel — le serveur l'a, pas
  // l'appareil.
  if (source !== undefined && source.kind !== 'inline') {
    const autorisees = valeursDataset?.[source.dataset];
    if (autorisees === undefined) return;

    for (const choisie of Array.isArray(valeur) ? valeur : [valeur]) {
      if (autorisees.has(String(choisie))) continue;
      signaler(
        'option-inconnue',
        `« ${String(choisie)} » ne figure pas dans le référentiel « ${source.dataset} ».`,
        question.name,
        chemin,
      );
    }
    return;
  }

  if (source?.kind !== 'inline') return;
  const options = question.options ?? [];
  const connues = new Map(options.map((o) => [o.value, o]));

  const valeurs = Array.isArray(valeur) ? valeur : [valeur];
  for (const choisie of valeurs) {
    const option = connues.get(String(choisie));
    if (option === undefined) {
      signaler(
        'option-inconnue',
        `« ${choisie} » ne fait pas partie des options de « ${question.name} ».`,
        question.name,
        chemin,
      );
      continue;
    }
    // La clé dérivée n'est légitime que si l'option choisie autorise le texte
    // libre : elle est attendue, donc elle ne part pas dans extraData.
    if (option.allowFreeText === true) {
      attendus.add(`${question.name}${SUFFIXE_TEXTE_LIBRE}`);
    }
  }
}

function validerCardinaliteMedia(
  question: Question,
  valeur: unknown,
  chemin: string,
  signaler: (code: string, message: string, name: string, chemin: string) => void,
): void {
  if (!Array.isArray(valeur)) return;
  if (question.maxCount !== undefined && valeur.length > question.maxCount) {
    signaler(
      'cardinalite-depassee',
      `« ${question.name} » porte ${valeur.length} valeurs pour un maximum de ${question.maxCount}.`,
      question.name,
      chemin,
    );
  }
  if (question.minCount !== undefined && valeur.length < question.minCount) {
    signaler(
      'cardinalite-insuffisante',
      `« ${question.name} » porte ${valeur.length} valeurs pour un minimum de ${question.minCount}.`,
      question.name,
      chemin,
    );
  }
}

function validerContrainte(
  question: Question,
  valeur: unknown,
  chemin: string,
  contexte: ContexteEvaluation,
  signaler: (code: string, message: string, name: string, chemin: string) => void,
): void {
  if (question.constraint === undefined) return;
  const resultat = analyser(question.constraint);
  if (!resultat.ok) return;

  const valeurCourante =
    typeof valeur === 'string' || typeof valeur === 'number' || typeof valeur === 'boolean'
      ? valeur
      : Array.isArray(valeur)
        ? valeur.map((v) => (typeof v === 'string' ? v : null))
        : null;

  const respectee = resultat.expression.evaluerBooleen(
    { ...contexte, valeurCourante },
    'constraint',
  );

  if (!respectee) {
    signaler(
      'contrainte-non-respectee',
      `La valeur de « ${question.name} » ne respecte pas sa contrainte.`,
      question.name,
      chemin,
    );
  }
}
