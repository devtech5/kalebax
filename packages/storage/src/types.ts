/**
 * Entités du stockage local — docs/stockage.md §3.
 *
 * Elles ne recopient pas le modèle serveur : l'appareil ne conserve que ce dont
 * il a besoin pour collecter et synchroniser. Ce qui vit uniquement côté
 * serveur — révisions, journal d'audit, appartenances — n'a rien à faire ici.
 */

/** États d'une soumission sur l'appareil — docs/synchronisation.md §4. */
export const ETATS_SOUMISSION = [
  'brouillon',
  'en_attente',
  'envoyee',
  'confirmee',
  'medias_en_attente',
  'echec_permanent',
] as const;

export type EtatSoumission = (typeof ETATS_SOUMISSION)[number];

/** États en file d'envoi, dans l'ordre où la synchronisation les traite. */
export const ETATS_A_ENVOYER: readonly EtatSoumission[] = ['en_attente', 'envoyee'];

export type StatutGeopoint =
  | 'captured'
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'skipped';

export interface SoumissionLocale {
  /** UUID généré sur l'appareil : c'est lui qui rend la réception idempotente. */
  readonly id: string;
  readonly formVersionId: string;
  readonly projectId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly etat: EtatSoumission;
  /** Horloge de l'appareil, non fiable et conservée telle quelle. */
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly startLatitude: number | null;
  readonly startLongitude: number | null;
  readonly startAccuracy: number | null;
  readonly startGeopointStatus: StatutGeopoint | null;
  /** Renseigné quand le serveur a répondu : `received` ou `rejected`. */
  readonly statutServeur: string | null;
  /** Code d'échec non transitoire, pour expliquer à l'agent ce qui bloque. */
  readonly codeEchec: string | null;
  readonly messageEchec: string | null;
  readonly nombreTentatives: number;
  /** Date de la prochaine tentative, pour la temporisation progressive. */
  readonly prochaineTentativeA: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EtatMedia = 'a_envoyer' | 'en_cours' | 'monte' | 'echec_permanent';

export interface MediaLocal {
  readonly id: string;
  readonly submissionId: string;
  readonly questionName: string;
  readonly kind: 'photo' | 'audio' | 'video' | 'signature' | 'file';
  /** Chemin du fichier sur l'appareil ; le contenu n'est jamais en base. */
  readonly cheminFichier: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** SHA-256, vérifié par le serveur au scellement. */
  readonly checksum: string;
  /** Reprise à l'octet près : le serveur reste la source de vérité. */
  readonly octetsEnvoyes: number;
  readonly etat: EtatMedia;
  readonly capturedAt: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface VersionFormulaireLocale {
  readonly id: string;
  readonly formId: string;
  readonly versionNumber: number;
  readonly schema: unknown;
  /** `published` ou `retired` : une version en brouillon ne descend jamais. */
  readonly status: string;
}

export interface JeuDonneesLocal {
  readonly nom: string;
  readonly version: number;
  readonly contenu: unknown;
}

/** Une soumission finalisée et ses médias, écrits d'un bloc ou pas du tout. */
export interface SoumissionAFinaliser {
  readonly soumission: Omit<
    SoumissionLocale,
    'etat' | 'statutServeur' | 'codeEchec' | 'messageEchec' | 'nombreTentatives' | 'prochaineTentativeA' | 'createdAt' | 'updatedAt'
  >;
  readonly medias: readonly Omit<MediaLocal, 'octetsEnvoyes' | 'etat'>[];
}

export interface ComptesParEtat {
  readonly brouillon: number;
  readonly en_attente: number;
  readonly envoyee: number;
  readonly confirmee: number;
  readonly medias_en_attente: number;
  readonly echec_permanent: number;
}
