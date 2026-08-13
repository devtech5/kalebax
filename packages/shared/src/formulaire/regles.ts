import {
  construireGraphe,
  extraireReferencesSituees,
  type Dependance,
} from '../expression/dependances.js';
import { analyser } from '../expression/index.js';
import {
  estMedia,
  estQuestion,
  estRepetition,
  estSelection,
  parcourir,
  SUFFIXE_TEXTE_LIBRE,
  VERSION_SCHEMA_COURANTE,
  type DocumentFormulaire,
  type Element,
  type Question,
} from './types.js';
import { typeDeSaisie, verifierTypes, type TypeInfere } from './typage.js';

export interface AnomalieDocument {
  readonly code: string;
  readonly message: string;
  /** Chemin des noms depuis la racine, pour situer l'anomalie dans le formulaire. */
  readonly chemin: readonly string[];
  /** Attribut concerné, quand l'anomalie porte sur un attribut précis. */
  readonly champ?: string;
}

/**
 * Attributs dont la valeur est une expression **recalculée** quand une réponse
 * change. Ce sont eux qui forment le graphe de dépendances.
 *
 * `constraint` en est délibérément exclue : elle est évaluée à la saisie de sa
 * propre question, sur une valeur qui existe déjà. Une contrainte qui se
 * référence elle-même n'est pas une boucle de calcul, et `.` est précisément
 * fait pour ce cas.
 */
const ATTRIBUTS_CALCULES = [
  'relevant',
  'required',
  'default',
  'calculation',
  'repeatCount',
] as const;

/**
 * Type que doit produire chaque attribut (§9 point 9).
 *
 * `default` et `calculation` sont absents : ils doivent produire le type de
 * leur propre question, qui n'est connu qu'au cas par cas.
 */
const RETOUR_ATTENDU: Readonly<Record<string, TypeInfere>> = {
  relevant: 'booleen',
  constraint: 'booleen',
  required: 'booleen',
  filter: 'booleen',
  repeatCount: 'nombre',
};

/** Toutes les expressions portées par un élément, avec le nom de leur attribut. */
function expressionsDe(element: Element): { champ: string; source: string }[] {
  const expressions: { champ: string; source: string }[] = [];
  const ajouter = (champ: string, source: unknown): void => {
    if (typeof source === 'string' && source.trim() !== '') {
      expressions.push({ champ, source });
    }
  };

  ajouter('relevant', element.relevant);

  if (estRepetition(element)) {
    ajouter('repeatCount', element.repeatCount);
  }

  if (estQuestion(element)) {
    ajouter('constraint', element.constraint);
    ajouter('default', element.default);
    ajouter('calculation', element.calculation);
    if (typeof element.required === 'string') ajouter('required', element.required);
    if (element.optionsSource?.kind === 'cascade') {
      ajouter('filter', element.optionsSource.filter);
    }
  }

  return expressions;
}

/**
 * Règles métier du document, celles que la validation structurelle ne peut pas
 * voir parce qu'elles portent sur le document entier.
 *
 * Toutes bloquent la publication. Une erreur découverte par un agent à 300 km
 * du bureau est un échec produit.
 */
export function validerRegles(document: DocumentFormulaire): AnomalieDocument[] {
  const anomalies: AnomalieDocument[] = [];
  const ajouter = (
    code: string,
    message: string,
    chemin: readonly string[],
    champ?: string,
  ): void => {
    anomalies.push(champ === undefined ? { code, message, chemin } : { code, message, chemin, champ });
  };

  /* -- version du format -- */

  if (document.schemaVersion > VERSION_SCHEMA_COURANTE) {
    ajouter(
      'version-trop-recente',
      `Ce formulaire utilise la version ${document.schemaVersion} du format, alors que cette application ne gère que la version ${VERSION_SCHEMA_COURANTE}. Mettez l'application à jour.`,
      [],
      'schemaVersion',
    );
    // Inutile d'aller plus loin : le reste du document peut être interprété de
    // travers, et un faux diagnostic est pire qu'un diagnostic manquant.
    return anomalies;
  }

  /* -- langues -- */

  if (!document.languages.includes(document.defaultLanguage)) {
    ajouter(
      'langue-par-defaut-absente',
      `La langue par défaut « ${document.defaultLanguage} » ne figure pas dans la liste des langues du formulaire.`,
      [],
      'defaultLanguage',
    );
  }

  if (document.title[document.defaultLanguage] === undefined) {
    ajouter(
      'libelle-incomplet',
      `Le titre du formulaire n'est pas traduit dans la langue par défaut (${document.defaultLanguage}).`,
      [],
      'title',
    );
  }

  /* -- parcours des éléments -- */

  const nomsVus = new Map<string, readonly string[]>();
  const identifiantsVus = new Map<string, readonly string[]>();
  const nomsConnus = new Set<string>();
  const dependances: Dependance[] = [];

  // Rang de déclaration et type de chaque élément, tous deux nécessaires avant
  // d'examiner la première expression.
  const rangs = new Map<string, number>();
  const typesParNom = new Map<string, TypeInfere>();
  let rang = 0;
  for (const { element } of parcourir(document)) {
    nomsConnus.add(element.name);
    if (!rangs.has(element.name)) rangs.set(element.name, rang);
    rang += 1;
    if (!typesParNom.has(element.name)) {
      typesParNom.set(
        element.name,
        estRepetition(element)
          ? 'tableau'
          : estQuestion(element)
            ? typeDeSaisie(element.type)
            : 'inconnu',
      );
    }
  }

  for (const situe of parcourir(document)) {
    const { element, chemin, repetitions } = situe;

    /* unicité */

    const dejaVu = nomsVus.get(element.name);
    if (dejaVu !== undefined) {
      ajouter(
        'nom-en-double',
        `Le nom « ${element.name} » est utilisé deux fois (déjà employé par ${dejaVu.join(' › ')}). Chaque nom devient une colonne à l'export et doit être unique.`,
        chemin,
        'name',
      );
    } else {
      nomsVus.set(element.name, chemin);
    }

    const idDejaVu = identifiantsVus.get(element.id);
    if (idDejaVu !== undefined) {
      ajouter(
        'identifiant-en-double',
        `L'identifiant « ${element.id} » est utilisé deux fois. Un identifiant est stable et jamais réutilisé : il sert à suivre une question d'une version à l'autre.`,
        chemin,
        'id',
      );
    } else {
      identifiantsVus.set(element.id, chemin);
    }

    /* libellés */

    if (element.label[document.defaultLanguage] === undefined) {
      ajouter(
        'libelle-incomplet',
        `« ${element.name} » n'a pas de libellé dans la langue par défaut (${document.defaultLanguage}).`,
        chemin,
        'label',
      );
    }

    /* répétitions */

    if (estRepetition(element)) {
      if (repetitions.length >= 2) {
        ajouter(
          'repetition-trop-imbriquee',
          "Les groupes répétables sont limités à deux niveaux d'imbrication : au-delà, la saisie sur petit écran et l'aplatissement à l'export deviennent ingérables.",
          chemin,
        );
      }
      if (element.minRepeat !== undefined && element.minRepeat > element.maxRepeat) {
        ajouter(
          'plafond-incoherent',
          `Le minimum d'occurrences (${element.minRepeat}) dépasse le maximum (${element.maxRepeat}).`,
          chemin,
          'minRepeat',
        );
      }
    }

    if (estQuestion(element)) {
      validerQuestion(element, chemin, nomsConnus, ajouter);
    }

    /* dépendances */

    const lit = new Set<string>();
    const rangCourant = rangs.get(element.name) ?? 0;
    const typeCourant = estQuestion(element) ? typeDeSaisie(element.type) : undefined;

    for (const { champ, source } of expressionsDe(element)) {
      const resultat = analyser(source, { nomsConnus });
      if (!resultat.ok) {
        for (const erreurExpression of resultat.erreurs) {
          ajouter(
            `expression-${erreurExpression.code}`,
            `${champ} : ${erreurExpression.message}`,
            chemin,
            champ,
          );
        }
        continue;
      }

      // Ordre de déclaration (§9 point 4) : une question ne peut pas dépendre
      // d'une réponse pas encore donnée. Les agrégats de groupe répétable en
      // sont exemptés, ils portent sur la collection entière.
      for (const reference of extraireReferencesSituees(resultat.expression.arbre)) {
        if (reference.compose) continue;
        const rangLu = rangs.get(reference.nom);
        if (rangLu !== undefined && rangLu > rangCourant) {
          ajouter(
            'reference-posterieure',
            `${champ} : « ${reference.nom} » est posée après « ${element.name} » dans le formulaire. Une question ne peut pas dépendre d'une réponse que l'agent n'a pas encore donnée.`,
            chemin,
            champ,
          );
        }
      }

      // Types (§9 points 5 et 9).
      const { type, anomalies: anomaliesType } = verifierTypes(resultat.expression.arbre, {
        typesParNom,
        typeCourant,
      });
      for (const anomalieType of anomaliesType) {
        ajouter('expression-type-incompatible', `${champ} : ${anomalieType.message}`, chemin, champ);
      }

      const attendu = RETOUR_ATTENDU[champ];
      if (attendu !== undefined && type !== 'inconnu' && type !== attendu) {
        ajouter(
          'retour-incompatible',
          `${champ} doit produire ${attendu === 'booleen' ? 'une condition vraie ou fausse' : 'un nombre'}, mais cette expression produit autre chose.`,
          chemin,
          champ,
        );
      }

      if (
        champ !== 'constraint' &&
        champ !== 'filter' &&
        (ATTRIBUTS_CALCULES as readonly string[]).includes(champ)
      ) {
        for (const reference of resultat.expression.references) lit.add(reference);
      }
    }
    dependances.push({ nom: element.name, lit: [...lit] });
  }

  /* -- cycles -- */

  const { cycle } = construireGraphe(dependances);
  if (cycle !== null && cycle.length > 0) {
    ajouter(
      'cycle-de-dependances',
      `Ces questions dépendent les unes des autres en boucle : ${cycle.join(' → ')}. Aucune ne peut être calculée en premier.`,
      [],
    );
  }

  return anomalies;
}

function validerQuestion(
  question: Question,
  chemin: readonly string[],
  nomsConnus: ReadonlySet<string>,
  ajouter: (
    code: string,
    message: string,
    chemin: readonly string[],
    champ?: string,
  ) => void,
): void {
  const { type, name } = question;

  /* -- listes d'options -- */

  if (estSelection(type)) {
    const source = question.optionsSource;
    if (source === undefined) {
      ajouter(
        'source-options-manquante',
        `« ${name} » est une question à choix mais ne déclare pas d'où viennent ses options.`,
        chemin,
        'optionsSource',
      );
    } else if (source.kind === 'inline') {
      if (question.options === undefined || question.options.length === 0) {
        ajouter(
          'options-manquantes',
          `« ${name} » déclare des options écrites dans le formulaire, mais la liste est vide.`,
          chemin,
          'options',
        );
      }
    } else if (question.options !== undefined) {
      ajouter(
        'options-superflues',
        `« ${name} » tire ses options du jeu de données « ${source.dataset} » : la liste écrite dans le formulaire ne serait jamais utilisée.`,
        chemin,
        'options',
      );
    }

    const valeursVues = new Set<string>();
    for (const option of question.options ?? []) {
      if (valeursVues.has(option.value)) {
        ajouter(
          'option-en-double',
          `La valeur « ${option.value} » apparaît deux fois dans les options de « ${name} ».`,
          chemin,
          'options',
        );
      }
      valeursVues.add(option.value);

      if (option.freeTextLabel !== undefined && option.allowFreeText !== true) {
        ajouter(
          'texte-libre-incoherent',
          `L'option « ${option.value} » porte un libellé de champ libre sans autoriser la saisie libre.`,
          chemin,
          'options',
        );
      }

      // La clé dérivée deviendra une colonne à l'export : elle ne doit pas
      // écraser une question existante.
      if (option.allowFreeText === true) {
        const cleDerivee = `${name}${SUFFIXE_TEXTE_LIBRE}`;
        if (nomsConnus.has(cleDerivee)) {
          ajouter(
            'collision-cle-derivee',
            `L'option libre de « ${name} » produira la colonne « ${cleDerivee} », qui est déjà le nom d'une autre question.`,
            chemin,
            'options',
          );
        }
      }
    }
  } else if (question.optionsSource !== undefined || question.options !== undefined) {
    ajouter(
      'options-inattendues',
      `« ${name} » est de type ${type} et ne peut pas porter de liste d'options.`,
      chemin,
      'options',
    );
  }

  /* -- médias -- */

  if (estMedia(type)) {
    if (question.maxCount === undefined) {
      ajouter(
        'plafond-media-manquant',
        `« ${name} » doit déclarer maxCount : sans plafond, une équipe sature le stockage d'un téléphone d'entrée de gamme en une journée de collecte.`,
        chemin,
        'maxCount',
      );
    } else if (question.minCount !== undefined && question.minCount > question.maxCount) {
      ajouter(
        'plafond-incoherent',
        `Le minimum de pièces jointes (${question.minCount}) dépasse le maximum (${question.maxCount}).`,
        chemin,
        'minCount',
      );
    }
  } else if (question.minCount !== undefined || question.maxCount !== undefined) {
    ajouter(
      'plafond-inattendu',
      `« ${name} » est de type ${type} et ne porte pas de pièce jointe : minCount et maxCount n'ont pas de sens ici.`,
      chemin,
      'maxCount',
    );
  }

  /* -- calculate et note -- */

  if (type === 'calculate') {
    if (question.calculation === undefined) {
      ajouter(
        'calcul-manquant',
        `« ${name} » est un champ calculé mais ne porte aucune expression de calcul.`,
        chemin,
        'calculation',
      );
    }
    if (question.required !== undefined) {
      ajouter(
        'attribut-inutile',
        `« ${name} » est calculé, jamais saisi : le rendre obligatoire n'a pas d'effet.`,
        chemin,
        'required',
      );
    }
  } else if (question.calculation !== undefined) {
    ajouter(
      'calcul-inattendu',
      `« ${name} » est de type ${type} : une expression de calcul n'est prise en compte que sur un champ de type calculate.`,
      chemin,
      'calculation',
    );
  }

  if (type === 'note') {
    for (const champ of ['required', 'constraint', 'default'] as const) {
      if (question[champ] !== undefined) {
        ajouter(
          'attribut-inutile',
          `« ${name} » est un texte d'information : il ne collecte aucune donnée, donc ${champ} n'a pas d'effet.`,
          chemin,
          champ,
        );
      }
    }
  }
}
