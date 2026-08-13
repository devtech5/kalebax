import type { MagasinLocal, MediaLocal } from '@kalebax/storage';
import { decouperEnLots, OCTETS_LOT_MAX, TAILLE_LOT_MAX } from './lots.js';
import { prochaineTentative } from './temporisation.js';
import {
  ErreurTransport,
  type LecteurFichiers,
  type ResultatElement,
  type TransportSync,
} from './transport.js';

/** Taille d'un morceau de média — docs/synchronisation.md §6.2. */
export const TAILLE_MORCEAU = 256 * 1024;

export interface OptionsMoteur {
  readonly tailleLotMax?: number;
  readonly octetsLotMax?: number;
  readonly tailleMorceau?: number;
  /** Nombre de médias traités par passage, pour ne pas monopoliser la connexion. */
  readonly mediasParPassage?: number;
  readonly hasard?: () => number;
  readonly maintenant?: () => Date;
}

export interface OptionsSynchronisation {
  /**
   * Les médias ne partent pas en données mobiles par défaut : l'agent paie
   * souvent son forfait, et le texte est la donnée qui compte. C'est
   * l'application qui tranche, selon le réseau et le réglage de l'agent.
   */
  readonly inclureMedias?: boolean;
  /** Nombre maximal de lots par passage ; sans limite, on vide toute la file. */
  readonly lotsMax?: number;
}

export interface RapportSync {
  readonly lotsEnvoyes: number;
  readonly soumissionsConfirmees: number;
  readonly soumissionsRefusees: number;
  readonly soumissionsReportees: number;
  readonly mediasMontes: number;
  readonly octetsMediasEnvoyes: number;
  /** Renseigné quand le passage s'est arrêté avant d'avoir tout traité. */
  readonly interrompuPar: string | null;
}

/**
 * Moteur de synchronisation — docs/synchronisation.md.
 *
 * Logique pure : il ne connaît ni HTTP, ni le système de fichiers, ni l'état du
 * réseau. Il orchestre un magasin et un transport, ce qui le rend intégralement
 * testable, y compris les scénarios qu'on ne sait pas provoquer sur un vrai
 * réseau — coupure entre l'envoi et la réponse, fichier abîmé en transit,
 * extinction en plein lot.
 */
export class MoteurSync {
  private readonly tailleLotMax: number;
  private readonly octetsLotMax: number;
  private readonly tailleMorceau: number;
  private readonly mediasParPassage: number;
  private readonly hasard: () => number;
  private readonly maintenant: () => Date;

  constructor(
    private readonly magasin: MagasinLocal,
    private readonly transport: TransportSync,
    private readonly fichiers: LecteurFichiers,
    options: OptionsMoteur = {},
  ) {
    this.tailleLotMax = options.tailleLotMax ?? TAILLE_LOT_MAX;
    this.octetsLotMax = options.octetsLotMax ?? OCTETS_LOT_MAX;
    this.tailleMorceau = options.tailleMorceau ?? TAILLE_MORCEAU;
    this.mediasParPassage = options.mediasParPassage ?? 10;
    this.hasard = options.hasard ?? Math.random;
    this.maintenant = options.maintenant ?? (() => new Date());
  }

  async synchroniser(options: OptionsSynchronisation = {}): Promise<RapportSync> {
    let lotsEnvoyes = 0;
    let confirmees = 0;
    let refusees = 0;
    let reportees = 0;
    let mediasMontes = 0;
    let octetsMedias = 0;
    let interrompuPar: string | null = null;

    const lotsMax = options.lotsMax ?? Number.POSITIVE_INFINITY;

    // Le texte d'abord, toujours : quelques kilo-octets qui passent sur un
    // réseau dégradé, là où les photos ne passeraient pas.
    envoi: while (lotsEnvoyes < lotsMax) {
      const enFile = await this.magasin.listerAEnvoyer(
        this.tailleLotMax,
        this.maintenant(),
      );
      if (enFile.length === 0) break;

      const lots = decouperEnLots(enFile, this.tailleLotMax, this.octetsLotMax);
      for (const lot of lots) {
        if (lotsEnvoyes >= lotsMax) break envoi;

        const ids = lot.soumissions.map((s) => s.id);
        await this.magasin.marquerEnvoyees(ids);

        let resultats: ResultatElement[];
        try {
          resultats = await this.transport.envoyerLot(lot.sortantes);
        } catch (erreur) {
          // Coupure avant la réponse : on ne sait pas si le serveur a reçu.
          // On repousse et on rejouera — l'identifiant client fait que le
          // serveur reconnaîtra les soumissions déjà enregistrées.
          const transitoire = !(erreur instanceof ErreurTransport) || erreur.transitoire;
          if (!transitoire) {
            interrompuPar = (erreur as ErreurTransport).code;
            break envoi;
          }
          for (const soumission of lot.soumissions) {
            await this.magasin.reporterTentative(
              soumission.id,
              prochaineTentative(soumission.nombreTentatives, this.maintenant(), this.hasard),
            );
            reportees += 1;
          }
          interrompuPar = erreur instanceof ErreurTransport ? erreur.code : 'reseau';
          break envoi;
        }

        lotsEnvoyes += 1;
        const parId = new Map(resultats.map((r) => [r.id, r]));

        for (const soumission of lot.soumissions) {
          const resultat = parId.get(soumission.id);

          // Un élément absent de la réponse n'est pas confirmé : il reste en
          // file et repartira au prochain passage.
          if (resultat === undefined) {
            await this.magasin.reporterTentative(
              soumission.id,
              prochaineTentative(soumission.nombreTentatives, this.maintenant(), this.hasard),
            );
            reportees += 1;
            continue;
          }

          if (resultat.etat === 'refusee') {
            await this.magasin.marquerEchecPermanent(
              soumission.id,
              resultat.code ?? 'refusee',
              resultat.message ?? 'Le serveur a refusé cette soumission.',
            );
            refusees += 1;
            continue;
          }

          // `rejected` est un accusé comme un autre : la donnée est enregistrée
          // côté serveur avec ses violations, pour arbitrage humain.
          await this.magasin.confirmerSoumission(soumission.id, resultat.status ?? 'received');
          confirmees += 1;
        }
      }
    }

    if (options.inclureMedias === true && interrompuPar === null) {
      const rapportMedias = await this.envoyerMedias();
      mediasMontes = rapportMedias.montes;
      octetsMedias = rapportMedias.octets;
      interrompuPar = rapportMedias.interrompuPar;
    }

    return {
      lotsEnvoyes,
      soumissionsConfirmees: confirmees,
      soumissionsRefusees: refusees,
      soumissionsReportees: reportees,
      mediasMontes,
      octetsMediasEnvoyes: octetsMedias,
      interrompuPar,
    };
  }

  private async envoyerMedias(): Promise<{
    montes: number;
    octets: number;
    interrompuPar: string | null;
  }> {
    const aEnvoyer = await this.magasin.listerMediasAEnvoyer(this.mediasParPassage);
    let montes = 0;
    let octets = 0;

    for (const media of aEnvoyer) {
      try {
        octets += await this.envoyerUnMedia(media);
        await this.magasin.marquerMediaMonte(media.id);
        montes += 1;
      } catch (erreur) {
        if (erreur instanceof ErreurTransport && !erreur.transitoire) {
          await this.magasin.marquerMediaEchec(media.id);
          continue;
        }
        // Coupure : la progression enregistrée permettra de reprendre où l'on
        // en était, pas de tout recommencer.
        return {
          montes,
          octets,
          interrompuPar: erreur instanceof ErreurTransport ? erreur.code : 'reseau',
        };
      }
    }

    return { montes, octets, interrompuPar: null };
  }

  private async envoyerUnMedia(media: MediaLocal): Promise<number> {
    // Le serveur dit ce qu'il détient déjà ; un compteur local divergerait au
    // premier redémarrage brutal.
    const { octetsRecus } = await this.transport.initierMedia(
      media.id,
      media.sizeBytes,
      media.checksum,
    );

    let offset = Math.min(Math.max(octetsRecus, 0), media.sizeBytes);
    if (offset !== media.octetsEnvoyes) {
      await this.magasin.enregistrerProgressionMedia(media.id, offset);
    }

    let envoyes = 0;
    while (offset < media.sizeBytes) {
      const longueur = Math.min(this.tailleMorceau, media.sizeBytes - offset);
      const morceau = await this.fichiers.lire(media.cheminFichier, offset, longueur);
      const reponse = await this.transport.envoyerMorceau(media.id, offset, morceau);

      envoyes += longueur;
      // On avance sur ce que le serveur confirme, jamais sur ce qu'on croit
      // avoir envoyé.
      offset = Math.min(Math.max(reponse.octetsRecus, offset + longueur), media.sizeBytes);
      await this.magasin.enregistrerProgressionMedia(media.id, offset);
    }

    try {
      await this.transport.completerMedia(media.id);
    } catch (erreur) {
      // Empreinte refusée : le fichier est arrivé abîmé, et un média corrompu
      // vaut moins que pas de média — il fait croire à une preuve. On repart de
      // zéro.
      if (erreur instanceof ErreurTransport && erreur.code === 'checksum-invalide') {
        await this.magasin.enregistrerProgressionMedia(media.id, 0);
      }
      throw erreur;
    }

    return envoyes;
  }
}
