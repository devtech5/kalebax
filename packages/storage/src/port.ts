import type {
  ComptesParEtat,
  EtatSoumission,
  JeuDonneesLocal,
  MediaLocal,
  SoumissionAFinaliser,
  SoumissionLocale,
  VersionFormulaireLocale,
} from './types.js';

/**
 * L'interface de persistance — docs/stockage.md.
 *
 * Aucun code métier n'appelle jamais un moteur de stockage directement : il
 * passe par ici, et par rien d'autre. C'est ce qui permet d'écrire la file de
 * synchronisation une seule fois pour les trois cibles.
 *
 * **Il n'y a pas de `transaction(fn)` générique**, et c'est délibéré :
 * IndexedDB referme ses transactions dès qu'un `await` extérieur rend la main,
 * si bien qu'un code écrit et testé sur SQLite se casserait dans le navigateur,
 * précisément là où l'on croyait garantir l'atomicité. Les enchaînements qui
 * doivent réussir ou échouer d'un bloc sont donc exposés comme des opérations
 * de haut niveau.
 */
export interface MagasinLocal {
  /** Applique les migrations en attente. À appeler avant tout le reste. */
  ouvrir(): Promise<void>;
  fermer(): Promise<void>;

  /* ----------------------------------------------------- brouillons */

  /** Crée ou remplace un brouillon. Sans effet sur une soumission finalisée. */
  enregistrerBrouillon(soumission: SoumissionLocale): Promise<void>;
  lireSoumission(id: string): Promise<SoumissionLocale | null>;
  listerBrouillons(): Promise<SoumissionLocale[]>;
  supprimerBrouillon(id: string): Promise<void>;

  /* -------------------------------------------------- file d'envoi */

  /**
   * Finalise une soumission et enfile ses médias, d'un bloc.
   *
   * Une soumission finalisée n'est plus modifiable sur l'appareil : toute
   * correction passe par la console d'un superviseur, qui crée une révision
   * attribuée.
   */
  finaliserSoumission(entree: SoumissionAFinaliser): Promise<void>;

  /** Premier arrivé, premier servi, et jamais celles qui attendent un délai. */
  listerAEnvoyer(limite: number, maintenant?: Date): Promise<SoumissionLocale[]>;

  marquerEnvoyees(ids: readonly string[]): Promise<void>;

  /**
   * Enregistre l'accusé du serveur.
   *
   * Passe en `medias_en_attente` s'il reste des pièces jointes à monter, en
   * `confirmee` sinon. `rejected` est un accusé comme un autre : la donnée est
   * enregistrée côté serveur avec ses violations, pour arbitrage humain.
   */
  confirmerSoumission(id: string, statutServeur: string): Promise<void>;

  /** Refus non transitoire : sortie de la file active, jamais supprimée. */
  marquerEchecPermanent(id: string, code: string, message: string): Promise<void>;

  /** Échec transitoire : compte la tentative et repousse la prochaine. */
  reporterTentative(id: string, prochaineTentativeA: Date): Promise<void>;

  listerParEtat(etat: EtatSoumission, limite?: number): Promise<SoumissionLocale[]>;
  compterParEtat(): Promise<ComptesParEtat>;

  /* ------------------------------------------------------- médias */

  listerMediasAEnvoyer(limite: number): Promise<MediaLocal[]>;
  listerMediasDeSoumission(submissionId: string): Promise<MediaLocal[]>;
  /** Reprise à l'octet près : la valeur vient du serveur, pas d'un compteur local. */
  enregistrerProgressionMedia(id: string, octetsEnvoyes: number): Promise<void>;
  marquerMediaMonte(id: string): Promise<void>;
  marquerMediaEchec(id: string): Promise<void>;

  /* ------------------------------------------------- formulaires */

  enregistrerVersionFormulaire(version: VersionFormulaireLocale): Promise<void>;
  lireVersionFormulaire(id: string): Promise<VersionFormulaireLocale | null>;
  listerVersionsFormulaire(): Promise<VersionFormulaireLocale[]>;
  /**
   * Supprime les versions qu'aucune soumission locale ne référence.
   *
   * Une version retirée reste tant qu'une soumission s'y rattache : sinon la
   * donnée deviendrait ininterprétable avant même d'être partie.
   */
  purgerVersionsInutilisees(): Promise<number>;

  /* --------------------------------------------------- référentiels */

  enregistrerJeuDonnees(jeu: JeuDonneesLocal): Promise<void>;
  lireJeuDonnees(nom: string): Promise<JeuDonneesLocal | null>;
  /** `{ points_vente: 12 }` — ce que l'appareil détient, pour le différentiel. */
  versionsJeuxDonnees(): Promise<Record<string, number>>;

  /* -------------------------------------------------------- purge */

  /**
   * Supprime les soumissions confirmées avant une date, **et seulement
   * celles-là**.
   *
   * Une soumission qui attend encore ses médias n'est pas confirmée : elle
   * survit à la purge.
   */
  purgerConfirmeesAvant(date: Date): Promise<number>;

  /* --------------------------------------------------- clé-valeur */

  lireMeta(cle: string): Promise<string | null>;
  ecrireMeta(cle: string, valeur: string): Promise<void>;
}
