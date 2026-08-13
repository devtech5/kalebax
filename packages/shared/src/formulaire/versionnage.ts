import {
  estQuestion,
  estRepetition,
  parcourir,
  type DocumentFormulaire,
  type Element,
  type Question,
  type Repetition,
} from './types.js';

/**
 * Comparaison de deux versions d'un formulaire — docs/formulaires.md §7.
 *
 * La comparaison se fait par **identifiant technique**, jamais par nom : `id`
 * est stable et ne change pas au renommage, c'est précisément ce qui permet de
 * suivre une question d'une version à l'autre et de distinguer un renommage
 * d'une suppression suivie d'un ajout.
 */

export type NatureChangement = 'compatible' | 'rupture';

export interface Changement {
  readonly nature: NatureChangement;
  readonly code: string;
  readonly message: string;
  /** Identifiant technique de l'élément concerné. */
  readonly id?: string;
  readonly name?: string;
}

export interface RapportComparaison {
  /** Alimente `FormVersion.breakingChange`. */
  readonly breakingChange: boolean;
  readonly changements: readonly Changement[];
  readonly ruptures: readonly Changement[];
}

function indexer(document: DocumentFormulaire): Map<string, Element> {
  const index = new Map<string, Element>();
  for (const { element } of parcourir(document)) {
    index.set(element.id, element);
  }
  return index;
}

/**
 * Compare deux documents et classe chaque écart.
 *
 * Une rupture n'interdit pas de publier : elle déclenche un avertissement
 * explicite au concepteur, avec la liste des incompatibilités et le nombre de
 * soumissions déjà collectées. Les soumissions reçues ne sont jamais migrées ni
 * retouchées — elles restent attachées à leur version.
 */
export function comparerVersions(
  precedent: DocumentFormulaire,
  suivant: DocumentFormulaire,
): RapportComparaison {
  const changements: Changement[] = [];
  const avant = indexer(precedent);
  const apres = indexer(suivant);

  const ajouter = (
    nature: NatureChangement,
    code: string,
    message: string,
    element: Element,
  ): void => {
    changements.push({ nature, code, message, id: element.id, name: element.name });
  };

  /* -- éléments disparus -- */

  for (const [id, element] of avant) {
    if (apres.has(id)) continue;
    ajouter(
      'rupture',
      'question-supprimee',
      `« ${element.name} » a été supprimée. Les soumissions déjà reçues conservent cette donnée, mais elle ne sera plus collectée.`,
      element,
    );
  }

  /* -- éléments apparus -- */

  for (const [id, element] of apres) {
    if (avant.has(id)) continue;
    const obligatoire = estQuestion(element) && element.required !== undefined && element.required !== false;
    if (obligatoire) {
      ajouter(
        'rupture',
        'question-obligatoire-ajoutee',
        `« ${element.name} » est une nouvelle question obligatoire : une saisie commencée sur la version précédente ne peut pas la renseigner.`,
        element,
      );
    } else {
      ajouter(
        'compatible',
        'question-ajoutee',
        `« ${element.name} » a été ajoutée.`,
        element,
      );
    }
  }

  /* -- éléments conservés -- */

  for (const [id, element] of apres) {
    const ancien = avant.get(id);
    if (ancien === undefined) continue;
    comparerElement(ancien, element, ajouter);
  }

  const ruptures = changements.filter((c) => c.nature === 'rupture');
  return { breakingChange: ruptures.length > 0, changements, ruptures };
}

function comparerElement(
  ancien: Element,
  nouveau: Element,
  ajouter: (
    nature: NatureChangement,
    code: string,
    message: string,
    element: Element,
  ) => void,
): void {
  if (ancien.name !== nouveau.name) {
    ajouter(
      'rupture',
      'nom-modifie',
      `« ${ancien.name} » est devenue « ${nouveau.name} ». Le nom est la colonne des exports : les données déjà collectées resteront sous l'ancien nom.`,
      nouveau,
    );
  }

  if (ancien.type !== nouveau.type) {
    ajouter(
      'rupture',
      'type-modifie',
      `« ${nouveau.name} » passe du type ${ancien.type} au type ${nouveau.type}. Les valeurs déjà collectées ne sont pas réinterprétables.`,
      nouveau,
    );
    // Les deux éléments n'ont plus la même nature : comparer leurs attributs
    // spécifiques ne produirait que du bruit.
    return;
  }

  comparerLibelles(ancien, nouveau, ajouter);
  comparerRelevant(ancien, nouveau, ajouter);

  if (estQuestion(ancien) && estQuestion(nouveau)) {
    comparerQuestion(ancien, nouveau, ajouter);
  } else if (estRepetition(ancien) && estRepetition(nouveau)) {
    comparerRepetition(ancien, nouveau, ajouter);
  }
}

function comparerLibelles(
  ancien: Element,
  nouveau: Element,
  ajouter: (n: NatureChangement, c: string, m: string, e: Element) => void,
): void {
  if (JSON.stringify(ancien.label) !== JSON.stringify(nouveau.label)) {
    ajouter('compatible', 'libelle-modifie', `Le libellé de « ${nouveau.name} » a changé.`, nouveau);
  }
  if (JSON.stringify(ancien.hint) !== JSON.stringify(nouveau.hint)) {
    ajouter('compatible', 'aide-modifiee', `L'aide de « ${nouveau.name} » a changé.`, nouveau);
  }
  if (ancien.appearance !== nouveau.appearance) {
    ajouter(
      'compatible',
      'apparence-modifiee',
      `L'affichage de « ${nouveau.name} » a changé.`,
      nouveau,
    );
  }
}

/**
 * `relevant` suit la même règle que `constraint` : on ne sait pas comparer deux
 * expressions, donc on ne prétend pas le faire. Toute modification est classée
 * en rupture, seule la suppression est un assouplissement certain.
 */
function comparerRelevant(
  ancien: Element,
  nouveau: Element,
  ajouter: (n: NatureChangement, c: string, m: string, e: Element) => void,
): void {
  if (ancien.relevant === nouveau.relevant) return;
  if (nouveau.relevant === undefined) {
    ajouter(
      'compatible',
      'pertinence-supprimee',
      `« ${nouveau.name} » est désormais toujours affichée.`,
      nouveau,
    );
    return;
  }
  ajouter(
    'rupture',
    'pertinence-modifiee',
    `La condition d'affichage de « ${nouveau.name} » a changé : des questions renseignées sur la version précédente pourraient ne plus être pertinentes.`,
    nouveau,
  );
}

function comparerQuestion(
  ancien: Question,
  nouveau: Question,
  ajouter: (n: NatureChangement, c: string, m: string, e: Element) => void,
): void {
  const etaitObligatoire = ancien.required !== undefined && ancien.required !== false;
  const estObligatoire = nouveau.required !== undefined && nouveau.required !== false;

  if (!etaitObligatoire && estObligatoire) {
    ajouter(
      'rupture',
      'devenue-obligatoire',
      `« ${nouveau.name} » devient obligatoire : les soumissions déjà reçues qui l'ont laissée vide ne satisferaient plus cette règle.`,
      nouveau,
    );
  } else if (etaitObligatoire && !estObligatoire) {
    ajouter(
      'compatible',
      'devenue-facultative',
      `« ${nouveau.name} » n'est plus obligatoire.`,
      nouveau,
    );
  }

  // Comparer deux expressions de contrainte pour décider laquelle est la plus
  // permissive est indécidable dans le cas général. On ne prétend pas savoir :
  // toute modification est traitée comme un durcissement, seule la suppression
  // est un assouplissement certain.
  if (ancien.constraint !== nouveau.constraint) {
    if (nouveau.constraint === undefined) {
      ajouter(
        'compatible',
        'contrainte-supprimee',
        `La contrainte de « ${nouveau.name} » a été retirée.`,
        nouveau,
      );
    } else {
      ajouter(
        'rupture',
        'contrainte-modifiee',
        `La contrainte de « ${nouveau.name} » a changé. Vérifiez les soumissions déjà reçues : certaines pourraient ne plus la satisfaire.`,
        nouveau,
      );
    }
  }

  /* options */

  const valeursAvant = new Set((ancien.options ?? []).map((o) => o.value));
  const valeursApres = new Set((nouveau.options ?? []).map((o) => o.value));

  for (const valeur of valeursAvant) {
    if (valeursApres.has(valeur)) continue;
    ajouter(
      'rupture',
      'option-supprimee',
      `L'option « ${valeur} » de « ${nouveau.name} » a été retirée. Si elle a déjà été choisie, ces réponses n'auront plus de libellé.`,
      nouveau,
    );
  }
  for (const valeur of valeursApres) {
    if (valeursAvant.has(valeur)) continue;
    ajouter(
      'compatible',
      'option-ajoutee',
      `L'option « ${valeur} » a été ajoutée à « ${nouveau.name} ».`,
      nouveau,
    );
  }

  if (JSON.stringify(ancien.optionsSource) !== JSON.stringify(nouveau.optionsSource)) {
    ajouter(
      'rupture',
      'source-options-modifiee',
      `« ${nouveau.name} » ne tire plus ses options de la même source.`,
      nouveau,
    );
  }

  /* plafonds de pièces jointes */

  if (
    ancien.maxCount !== undefined &&
    nouveau.maxCount !== undefined &&
    nouveau.maxCount < ancien.maxCount
  ) {
    ajouter(
      'rupture',
      'plafond-abaisse',
      `« ${nouveau.name} » n'accepte plus que ${nouveau.maxCount} pièces jointes au lieu de ${ancien.maxCount}.`,
      nouveau,
    );
  }
  if ((nouveau.minCount ?? 0) > (ancien.minCount ?? 0)) {
    ajouter(
      'rupture',
      'minimum-releve',
      `« ${nouveau.name} » exige désormais au moins ${nouveau.minCount} pièces jointes.`,
      nouveau,
    );
  }
}

function comparerRepetition(
  ancien: Repetition,
  nouveau: Repetition,
  ajouter: (n: NatureChangement, c: string, m: string, e: Element) => void,
): void {
  if (nouveau.maxRepeat < ancien.maxRepeat) {
    ajouter(
      'rupture',
      'plafond-abaisse',
      `« ${nouveau.name} » n'accepte plus que ${nouveau.maxRepeat} occurrences au lieu de ${ancien.maxRepeat}. Des soumissions déjà reçues peuvent en compter davantage.`,
      nouveau,
    );
  }
  if ((nouveau.minRepeat ?? 0) > (ancien.minRepeat ?? 0)) {
    ajouter(
      'rupture',
      'minimum-releve',
      `« ${nouveau.name} » exige désormais au moins ${nouveau.minRepeat} occurrences.`,
      nouveau,
    );
  }
}
