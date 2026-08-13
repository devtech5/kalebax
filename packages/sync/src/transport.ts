import type { SoumissionLocale } from '@kalebax/storage';

/**
 * Ce que le moteur attend du réseau — et rien de plus.
 *
 * Le moteur n'interroge jamais l'état de connectivité du système : un appareil
 * peut être « connecté » à un portail wifi captif sans accès à internet. La
 * seule vérité est une requête qui aboutit, donc le moteur tente et interprète
 * l'échec.
 */

/** Soumission telle qu'elle part sur le réseau, sans les champs locaux. */
export interface SoumissionSortante {
  readonly id: string;
  readonly formVersionId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly startLatitude: number | null;
  readonly startLongitude: number | null;
  readonly startAccuracy: number | null;
  readonly startGeopointStatus: string | null;
}

export type EtatElement = 'recue' | 'deja' | 'refusee';

export interface ResultatElement {
  readonly id: string;
  readonly etat: EtatElement;
  /** `received` ou `rejected` — présent sauf si l'élément est refusé. */
  readonly status?: string | undefined;
  /** Motif d'un refus non transitoire, à montrer à l'agent. */
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

export interface TransportSync {
  /** Un lot, un résultat par élément : le serveur ne fait pas tout ou rien. */
  envoyerLot(soumissions: readonly SoumissionSortante[]): Promise<ResultatElement[]>;

  /**
   * Annonce un média et demande combien d'octets le serveur détient déjà.
   *
   * C'est le serveur qui fait foi, pas un compteur local : ce dernier
   * divergerait au premier redémarrage brutal.
   */
  initierMedia(
    mediaId: string,
    tailleTotale: number,
    checksum: string,
  ): Promise<{ octetsRecus: number }>;

  envoyerMorceau(
    mediaId: string,
    offset: number,
    morceau: Uint8Array,
  ): Promise<{ octetsRecus: number }>;

  /** Le serveur vérifie le SHA-256 annoncé et scelle, ou refuse. */
  completerMedia(mediaId: string): Promise<void>;
}

/** Accès aux fichiers de l'appareil, différent sur chaque cible. */
export interface LecteurFichiers {
  lire(chemin: string, offset: number, longueur: number): Promise<Uint8Array>;
}

/**
 * Échec d'une opération réseau.
 *
 * `transitoire` porte toute la décision : réessayer plus tard, ou sortir la
 * soumission de la file en la conservant et en prévenant l'agent.
 */
export class ErreurTransport extends Error {
  constructor(
    override readonly message: string,
    readonly transitoire: boolean,
    readonly code = 'transport',
  ) {
    super(message);
    this.name = 'ErreurTransport';
  }
}

/** Le média envoyé ne correspond pas à son empreinte : tout est à refaire. */
export class ErreurChecksum extends ErreurTransport {
  constructor(mediaId: string) {
    super(
      `Le fichier ${mediaId} est arrivé abîmé et a été refusé.`,
      true,
      'checksum-invalide',
    );
    this.name = 'ErreurChecksum';
  }
}

export function versSortante(soumission: SoumissionLocale): SoumissionSortante {
  return {
    id: soumission.id,
    formVersionId: soumission.formVersionId,
    data: soumission.data,
    startedAt: soumission.startedAt,
    completedAt: soumission.completedAt,
    deviceId: soumission.deviceId,
    appVersion: soumission.appVersion,
    startLatitude: soumission.startLatitude,
    startLongitude: soumission.startLongitude,
    startAccuracy: soumission.startAccuracy,
    startGeopointStatus: soumission.startGeopointStatus,
  };
}
