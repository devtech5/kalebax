import {
  analyser,
  estGroupe,
  estQuestion,
  estRepetition,
  parcourir,
  type ContexteEvaluation,
  type DocumentFormulaire,
  type Element,
  type ExpressionCompilee,
  type Question,
  type Repetition,
} from '@kalebax/shared';
import type {
  ElementAffichable,
  Emplacement,
  OptionsRuntime,
  Page,
  ResultatFinalisation,
  ViolationSaisie,
} from './types.js';

/** Expressions compilées d'un élément, une fois pour toute la saisie. */
interface ExpressionsElement {
  readonly relevant?: ExpressionCompilee | undefined;
  readonly constraint?: ExpressionCompilee | undefined;
  readonly required?: ExpressionCompilee | undefined;
  readonly defaut?: ExpressionCompilee | undefined;
  readonly calculation?: ExpressionCompilee | undefined;
  readonly repeatCount?: ExpressionCompilee | undefined;
}

/**
 * État d'une saisie en cours — docs/runtime-saisie.md.
 *
 * Le module ne rend rien : il répond à trois questions et à rien d'autre. Que
 * faut-il afficher, qu'est-ce qui ne va pas, et que vaut la soumission.
 *
 * Périmètre de cette version : questions à la racine, dans des groupes, et dans
 * des groupes répétables de premier niveau. Le schéma autorise deux niveaux
 * d'imbrication ; le second sera traité dans une session dédiée.
 */
export class RuntimeSaisie {
  private readonly donnees: Record<string, unknown> = {};
  /**
   * Réponses des questions devenues non pertinentes.
   *
   * Elles ne sont pas détruites : l'agent qui coche « non » par erreur puis
   * revient sur « oui » ne doit pas avoir à tout ressaisir. Elles restent hors
   * des données produites et ne quittent jamais l'appareil.
   */
  private readonly reserve = new Map<string, unknown>();
  private readonly defautsAppliques = new Set<string>();
  private readonly expressions = new Map<string, ExpressionsElement>();
  private readonly pertinence = new Map<string, boolean>();
  /** Qui doit être réévalué quand tel nom change. */
  private readonly dependants = new Map<string, Set<string>>();
  private readonly elements: Element[] = [];
  /** Groupe ou répétition englobant, pour propager la pertinence. */
  private readonly parents = new Map<string, string>();
  private readonly now: string;
  private indexPage = 0;

  private constructor(
    private readonly document: DocumentFormulaire,
    options: OptionsRuntime,
  ) {
    this.now = options.now ?? new Date().toISOString();

    for (const { element, chemin } of parcourir(document)) {
      this.elements.push(element);
      this.expressions.set(element.name, this.compiler(element));
      const parent = chemin[chemin.length - 2];
      if (parent !== undefined) this.parents.set(element.name, parent);
    }
    this.construireDependances();

    if (options.donneesInitiales !== undefined) {
      Object.assign(this.donnees, structuredClone(options.donneesInitiales));
    }

    this.recalculerTout();
  }

  static creer(
    document: DocumentFormulaire,
    options: OptionsRuntime = {},
  ): RuntimeSaisie {
    return new RuntimeSaisie(document, options);
  }

  /* ------------------------------------------------------- compilation */

  private compiler(element: Element): ExpressionsElement {
    const compilee = (source?: string): ExpressionCompilee | undefined => {
      if (source === undefined || source.trim() === '') return undefined;
      const resultat = analyser(source);
      // Une expression invalide a été refusée à la publication. Si elle arrive
      // ici, on l'ignore plutôt que d'empêcher la saisie.
      return resultat.ok ? resultat.expression : undefined;
    };

    const expressions: Record<string, ExpressionCompilee | undefined> = {
      relevant: compilee(element.relevant),
    };

    if (estRepetition(element)) {
      expressions['repeatCount'] = compilee(element.repeatCount);
    }
    if (estQuestion(element)) {
      expressions['constraint'] = compilee(element.constraint);
      expressions['defaut'] = compilee(element.default);
      expressions['calculation'] = compilee(element.calculation);
      if (typeof element.required === 'string') {
        expressions['required'] = compilee(element.required);
      }
    }

    return expressions as ExpressionsElement;
  }

  private construireDependances(): void {
    for (const [nom, expressions] of this.expressions) {
      for (const expression of Object.values(expressions)) {
        if (expression === undefined) continue;
        for (const lu of expression.references) {
          const liste = this.dependants.get(lu);
          if (liste === undefined) this.dependants.set(lu, new Set([nom]));
          else liste.add(nom);
        }
      }
    }
  }

  /**
   * Fermeture transitive : qui doit être réévalué si ces noms changent.
   *
   * Elle suit deux liens. Les dépendances d'expression — qui lit qui — et la
   * descendance : un enfant n'a pas d'expression propre, mais sa pertinence
   * dépend de celle de son groupe. L'oublier laisserait une page masquée le
   * rester après que sa condition est devenue vraie.
   */
  private impactes(noms: readonly string[]): Set<string> {
    const atteints = new Set<string>(noms);
    const aTraiter = [...noms];

    while (aTraiter.length > 0) {
      const courant = aTraiter.pop() as string;

      for (const dependant of this.dependants.get(courant) ?? []) {
        if (atteints.has(dependant)) continue;
        atteints.add(dependant);
        aTraiter.push(dependant);
      }

      for (const [enfant, parent] of this.parents) {
        if (parent !== courant || atteints.has(enfant)) continue;
        atteints.add(enfant);
        aTraiter.push(enfant);
      }
    }

    return atteints;
  }

  /* --------------------------------------------------------- contexte */

  private contexte(emplacement?: Emplacement): ContexteEvaluation {
    if (emplacement === undefined) {
      return { donnees: this.donnees, now: this.now };
    }
    const occurrence = this.occurrences(emplacement.repeat)[emplacement.index];
    return {
      donnees: this.donnees,
      now: this.now,
      portees: occurrence === undefined ? [] : [occurrence],
      position: emplacement.index + 1,
    };
  }

  private occurrences(nomRepeat: string): Record<string, unknown>[] {
    const brut = this.donnees[nomRepeat];
    if (Array.isArray(brut)) return brut as Record<string, unknown>[];
    const nouveau: Record<string, unknown>[] = [];
    this.donnees[nomRepeat] = nouveau;
    return nouveau;
  }

  /* ------------------------------------------------------- pertinence */

  private cle(name: string, emplacement?: Emplacement): string {
    return emplacement === undefined
      ? name
      : `${emplacement.repeat}[${emplacement.index}].${name}`;
  }

  private recalculerTout(): void {
    this.recalculer(this.elements.map((e) => e.name));
  }

  /**
   * Réévalue ce qui dépend des noms modifiés, dans l'ordre du document.
   *
   * L'ordre du document suffit : la publication refuse déjà toute référence à
   * une question posée plus loin, donc une dépendance est toujours calculée
   * avant celui qui la lit.
   */
  private recalculer(nomsChanges: readonly string[]): void {
    const aRevoir = this.impactes(nomsChanges);

    for (const element of this.elements) {
      const dansRepeat = this.repeatParent(element.name);
      if (dansRepeat !== null) continue; // traité par occurrence, plus bas
      if (!aRevoir.has(element.name) && this.pertinence.has(element.name)) continue;

      this.appliquerPertinence(element, undefined);
      this.appliquerCalcul(element, undefined);
    }

    for (const element of this.elements) {
      const repeat = this.repeatParent(element.name);
      if (repeat === null) continue;
      const occurrences = this.occurrences(repeat.name);
      for (let index = 0; index < occurrences.length; index += 1) {
        const emplacement = { repeat: repeat.name, index };
        this.appliquerPertinence(element, emplacement);
        this.appliquerCalcul(element, emplacement);
      }
    }

    this.ajusterOccurrencesPilotees();
  }

  private appliquerPertinence(element: Element, emplacement?: Emplacement): void {
    const expression = this.expressions.get(element.name)?.relevant;
    const propre =
      expression === undefined
        ? true
        : expression.evaluerBooleen(this.contexte(emplacement), 'relevant');

    // Une question dans un groupe masqué est masquée. Sans cette propagation,
    // elle resterait exigée à la validation et son écran s'afficherait vide.
    // Les parents précèdent leurs enfants dans l'ordre du document, leur
    // pertinence est donc déjà connue.
    const parent = this.parents.get(element.name);
    const pertinent =
      propre && (parent === undefined || this.pertinence.get(this.cle(parent, emplacement)) !== false);

    const cle = this.cle(element.name, emplacement);
    const avant = this.pertinence.get(cle);
    this.pertinence.set(cle, pertinent);
    if (avant === pertinent) return;

    if (!estQuestionOuRepeat(element)) return;

    if (!pertinent) {
      const valeur = this.lireBrut(element.name, emplacement);
      if (valeur !== undefined) {
        this.reserve.set(cle, valeur);
        this.ecrireBrut(element.name, undefined, emplacement);
      }
      return;
    }

    // Retour en pertinence : on rend ce qui avait été mis de côté.
    if (this.reserve.has(cle)) {
      this.ecrireBrut(element.name, this.reserve.get(cle), emplacement);
      this.reserve.delete(cle);
    }
  }

  private appliquerCalcul(element: Element, emplacement?: Emplacement): void {
    if (!estQuestion(element) || element.type !== 'calculate') return;
    const expression = this.expressions.get(element.name)?.calculation;
    if (expression === undefined) return;
    if (this.pertinence.get(this.cle(element.name, emplacement)) === false) return;

    const { valeur } = expression.evaluer(this.contexte(emplacement));
    this.ecrireBrut(element.name, valeur ?? undefined, emplacement);
  }

  /**
   * Ajuste le nombre d'occurrences d'un repeat piloté par expression.
   *
   * **Sans jamais supprimer une occurrence renseignée** : une réponse saisie ne
   * disparaît pas parce qu'un nombre a changé ailleurs.
   */
  private ajusterOccurrencesPilotees(): void {
    for (const element of this.elements) {
      if (!estRepetition(element)) continue;
      const expression = this.expressions.get(element.name)?.repeatCount;
      if (expression === undefined) continue;

      const { valeur } = expression.evaluer(this.contexte());
      if (typeof valeur !== 'number' || !Number.isFinite(valeur)) continue;

      const voulu = Math.max(0, Math.min(Math.trunc(valeur), element.maxRepeat));
      const occurrences = this.occurrences(element.name);
      while (occurrences.length < voulu) occurrences.push({});
      while (occurrences.length > voulu) {
        const derniere = occurrences[occurrences.length - 1];
        if (derniere !== undefined && Object.keys(derniere).length > 0) break;
        occurrences.pop();
      }
    }
  }

  /* ---------------------------------------------------------- lecture */

  private lireBrut(name: string, emplacement?: Emplacement): unknown {
    if (emplacement === undefined) return this.donnees[name];
    return this.occurrences(emplacement.repeat)[emplacement.index]?.[name];
  }

  private ecrireBrut(name: string, valeur: unknown, emplacement?: Emplacement): void {
    if (emplacement === undefined) {
      if (valeur === undefined) delete this.donnees[name];
      else this.donnees[name] = valeur;
      return;
    }
    const occurrence = this.occurrences(emplacement.repeat)[emplacement.index];
    if (occurrence === undefined) return;
    if (valeur === undefined) delete occurrence[name];
    else occurrence[name] = valeur;
  }

  private repeatParent(name: string): Repetition | null {
    for (const { element, repetitions } of parcourir(this.document)) {
      if (element.name !== name) continue;
      const nom = repetitions[repetitions.length - 1];
      if (nom === undefined) return null;
      return (
        (this.elements.find((e) => e.name === nom && estRepetition(e)) as
          | Repetition
          | undefined) ?? null
      );
    }
    return null;
  }

  private element(name: string): Element | undefined {
    return this.elements.find((e) => e.name === name);
  }

  /* ------------------------------------------------------- API publique */

  /** Valeur courante d'une question. */
  lire(name: string, emplacement?: Emplacement): unknown {
    return this.lireBrut(name, emplacement);
  }

  estPertinent(name: string, emplacement?: Emplacement): boolean {
    return this.pertinence.get(this.cle(name, emplacement)) ?? true;
  }

  /** Enregistre une réponse et propage ce qui en dépend. */
  repondre(name: string, valeur: unknown, emplacement?: Emplacement): void {
    const element = this.element(name);
    if (element === undefined || !estQuestion(element)) return;
    // Un champ calculé est dérivé : le saisir n'aurait pas de sens, et sa
    // valeur serait écrasée au premier recalcul.
    if (element.type === 'calculate') return;

    this.ecrireBrut(name, valeur === null ? undefined : valeur, emplacement);
    // Une réponse effacée l'est délibérément : la marquer empêche le défaut de
    // se réappliquer et de contredire l'agent.
    this.defautsAppliques.add(this.cle(name, emplacement));

    // Une réponse saisie dans une occurrence change aussi les agrégats du
    // groupe — `sum(${produits.prix})` dépend de `produits`, pas de `prix`.
    this.recalculer(
      emplacement === undefined ? [name] : [name, emplacement.repeat],
    );
  }

  /**
   * Applique la valeur par défaut d'une question, si elle n'a jamais été
   * appliquée et que la question est vide.
   */
  appliquerDefaut(name: string, emplacement?: Emplacement): void {
    const cle = this.cle(name, emplacement);
    if (this.defautsAppliques.has(cle)) return;
    this.defautsAppliques.add(cle);

    const expression = this.expressions.get(name)?.defaut;
    if (expression === undefined) return;
    if (this.lireBrut(name, emplacement) !== undefined) return;

    const { valeur } = expression.evaluer(this.contexte(emplacement));
    if (valeur === null) return;
    this.ecrireBrut(name, valeur, emplacement);
    this.recalculer([name]);
  }

  /* ------------------------------------------------ groupes répétables */

  nombreOccurrences(nomRepeat: string): number {
    return this.occurrences(nomRepeat).length;
  }

  ajouterOccurrence(nomRepeat: string): boolean {
    const element = this.element(nomRepeat);
    if (element === undefined || !estRepetition(element)) return false;

    const occurrences = this.occurrences(nomRepeat);
    if (occurrences.length >= element.maxRepeat) return false;

    occurrences.push({});
    this.recalculer([nomRepeat]);
    return true;
  }

  supprimerOccurrence(nomRepeat: string, index: number): boolean {
    const element = this.element(nomRepeat);
    if (element === undefined || !estRepetition(element)) return false;

    const occurrences = this.occurrences(nomRepeat);
    if (index < 0 || index >= occurrences.length) return false;
    if (occurrences.length <= (element.minRepeat ?? 0)) return false;

    occurrences.splice(index, 1);
    this.recalculer([nomRepeat]);
    return true;
  }

  /* ------------------------------------------------------------ pages */

  /**
   * Découpage en pages — docs/runtime-saisie.md §8.
   *
   * Un groupe porteur de `field-list` forme une page ; le reste s'enchaîne
   * question par question, comme dans les outils dont les agents ont
   * l'habitude.
   */
  pages(): Page[] {
    const pages: Page[] = [];
    const ajouter = (groupe: Element | undefined, elements: ElementAffichable[]): void => {
      if (elements.length === 0) return;
      pages.push({
        index: pages.length,
        groupe,
        elements,
        // Une page dont tout est masqué est sautée : un écran vide fait croire
        // à un bug.
        visible: elements.some((e) => e.pertinent),
      });
    };

    for (const element of this.document.children) {
      if (estGroupe(element) && element.appearance === 'field-list') {
        ajouter(
          element,
          element.children.map((enfant) => this.affichable(enfant)),
        );
        continue;
      }
      if (estGroupe(element)) {
        for (const enfant of element.children) ajouter(undefined, [this.affichable(enfant)]);
        continue;
      }
      ajouter(undefined, [this.affichable(element)]);
    }

    return pages;
  }

  private affichable(element: Element): ElementAffichable {
    return { element, pertinent: this.estPertinent(element.name) };
  }

  pageCourante(): number {
    return this.indexPage;
  }

  /** Rend l'index de la page atteinte, ou `null` s'il n'y en a plus. */
  allerSuivant(): number | null {
    return this.deplacer(1);
  }

  allerPrecedent(): number | null {
    return this.deplacer(-1);
  }

  private deplacer(sens: 1 | -1): number | null {
    const pages = this.pages();
    for (let index = this.indexPage + sens; index >= 0 && index < pages.length; index += sens) {
      if (pages[index]?.visible !== true) continue;
      this.indexPage = index;
      return index;
    }
    return null;
  }

  /* ------------------------------------------------------- violations */

  /** Ce qui ne va pas, à l'instant présent. Le runtime signale, il ne bloque pas. */
  violations(): ViolationSaisie[] {
    const violations: ViolationSaisie[] = [];

    for (const element of this.elements) {
      if (!estQuestion(element)) {
        if (estRepetition(element)) this.verifierCardinalite(element, violations);
        continue;
      }
      if (element.type === 'calculate' || element.type === 'note') continue;

      const repeat = this.repeatParent(element.name);
      if (repeat === null) {
        this.verifierQuestion(element, undefined, violations);
        continue;
      }
      const occurrences = this.occurrences(repeat.name);
      for (let index = 0; index < occurrences.length; index += 1) {
        this.verifierQuestion(element, { repeat: repeat.name, index }, violations);
      }
    }

    return violations;
  }

  private verifierQuestion(
    question: Question,
    emplacement: Emplacement | undefined,
    violations: ViolationSaisie[],
  ): void {
    if (!this.estPertinent(question.name, emplacement)) return;

    const valeur = this.lireBrut(question.name, emplacement);
    const vide =
      valeur === undefined ||
      valeur === null ||
      (typeof valeur === 'string' && valeur.trim() === '') ||
      (Array.isArray(valeur) && valeur.length === 0);

    if (vide) {
      if (this.estObligatoire(question, emplacement)) {
        violations.push({
          name: question.name,
          code: 'requise',
          message: 'Cette question attend une réponse.',
          emplacement,
        });
      }
      return;
    }

    const contrainte = this.expressions.get(question.name)?.constraint;
    if (contrainte === undefined) return;

    const contexte = { ...this.contexte(emplacement), valeurCourante: valeur as never };
    if (!contrainte.evaluerBooleen(contexte, 'constraint')) {
      violations.push({
        name: question.name,
        code: 'contrainte',
        message:
          question.constraintMessage?.[this.document.defaultLanguage] ??
          'Cette réponse ne respecte pas la règle de saisie.',
        emplacement,
      });
    }
  }

  private estObligatoire(question: Question, emplacement?: Emplacement): boolean {
    if (question.required === true) return true;
    if (question.required === undefined || question.required === false) return false;
    const expression = this.expressions.get(question.name)?.required;
    return expression?.evaluerBooleen(this.contexte(emplacement), 'required') ?? false;
  }

  private verifierCardinalite(repeat: Repetition, violations: ViolationSaisie[]): void {
    if (!this.estPertinent(repeat.name)) return;
    const nombre = this.occurrences(repeat.name).length;

    if (repeat.minRepeat !== undefined && nombre < repeat.minRepeat) {
      violations.push({
        name: repeat.name,
        code: 'cardinalite',
        message: `Ce groupe attend au moins ${repeat.minRepeat} occurrence(s).`,
      });
    }
    if (nombre > repeat.maxRepeat) {
      violations.push({
        name: repeat.name,
        code: 'cardinalite',
        message: `Ce groupe accepte au plus ${repeat.maxRepeat} occurrence(s).`,
      });
    }
  }

  /* ------------------------------------------------------ finalisation */

  /**
   * Produit les données de la soumission.
   *
   * Rend toujours des données, accompagnées des violations restantes : un agent
   * bloqué par une contrainte mal écrite à 300 km du bureau est un échec
   * produit, et le serveur enregistre de toute façon une soumission non
   * conforme avec ses violations plutôt que de la perdre.
   *
   * La réserve n'en fait pas partie : une donnée que le formulaire déclare non
   * pertinente n'a pas à quitter l'appareil.
   */
  finaliser(): ResultatFinalisation {
    const violations = this.violations();
    return {
      donnees: structuredClone(this.donnees),
      violations,
      complet: violations.length === 0,
    };
  }

  /** Réponses mises de côté, pour l'inspection et les tests. */
  valeursEnReserve(): Record<string, unknown> {
    return Object.fromEntries(this.reserve);
  }
}

function estQuestionOuRepeat(element: Element): boolean {
  return estQuestion(element) || estRepetition(element);
}
