import type { LecteurFichiers, ResultatElement, SoumissionSortante, TransportSync } from './transport.js';
import { ErreurTransport } from './transport.js';

/**
 * Serveur simulé, pour les tests.
 *
 * Il reproduit les scénarios qu'on ne sait pas provoquer sur un vrai réseau et
 * qui sont pourtant le quotidien du terrain : coupure entre l'envoi et la
 * réponse, lot à moitié traité, fichier arrivé abîmé, reprise à un offset que
 * le client ignorait.
 */
export class TransportSimule implements TransportSync {
  /** Soumissions que le serveur a réellement enregistrées, par identifiant. */
  readonly recues = new Map<string, SoumissionSortante>();
  readonly appelsLot: SoumissionSortante[][] = [];
  readonly medias = new Map<string, { octets: number; scelle: boolean }>();

  /** Erreur levée au prochain envoi de lot, puis effacée. */
  prochaineErreurLot: Error | null = null;
  /** Simule une coupure après enregistrement serveur, avant la réponse. */
  perdreLaReponse = false;
  /** Ne renvoie un résultat que pour les N premiers éléments du lot. */
  resultatsPartiels: number | null = null;
  /** Force un refus non transitoire sur ces identifiants. */
  readonly aRefuser = new Set<string>();
  /** Refuse l'empreinte à la finalisation de ces médias, une fois. */
  readonly checksumsARefuser = new Set<string>();
  /** Octets déjà détenus, annoncés à l'initiation d'un média. */
  readonly offsetsInitiaux = new Map<string, number>();
  /** Coupe l'envoi d'un média après cet offset. */
  couperMediaApres: number | null = null;

  async envoyerLot(soumissions: readonly SoumissionSortante[]): Promise<ResultatElement[]> {
    this.appelsLot.push([...soumissions]);

    if (this.prochaineErreurLot !== null) {
      const erreur = this.prochaineErreurLot;
      this.prochaineErreurLot = null;
      throw erreur;
    }

    const resultats: ResultatElement[] = [];
    for (const soumission of soumissions) {
      if (this.aRefuser.has(soumission.id)) {
        resultats.push({
          id: soumission.id,
          etat: 'refusee',
          code: 'version-inconnue',
          message: "Cette version de formulaire n'existe pas.",
        });
        continue;
      }

      const deja = this.recues.has(soumission.id);
      if (!deja) this.recues.set(soumission.id, soumission);
      resultats.push({
        id: soumission.id,
        etat: deja ? 'deja' : 'recue',
        status: 'received',
      });
    }

    if (this.perdreLaReponse) {
      this.perdreLaReponse = false;
      // Le serveur a enregistré, la réponse n'arrive jamais.
      throw new ErreurTransport('Connexion interrompue', true, 'coupure');
    }

    if (this.resultatsPartiels !== null) {
      const limite = this.resultatsPartiels;
      this.resultatsPartiels = null;
      return resultats.slice(0, limite);
    }

    return resultats;
  }

  async initierMedia(
    mediaId: string,
    _tailleTotale: number,
    _checksum: string,
  ): Promise<{ octetsRecus: number }> {
    const connu = this.medias.get(mediaId);
    if (connu !== undefined) return { octetsRecus: connu.octets };

    const initial = this.offsetsInitiaux.get(mediaId) ?? 0;
    this.medias.set(mediaId, { octets: initial, scelle: false });
    return { octetsRecus: initial };
  }

  async envoyerMorceau(
    mediaId: string,
    offset: number,
    morceau: Uint8Array,
  ): Promise<{ octetsRecus: number }> {
    const etat = this.medias.get(mediaId);
    if (etat === undefined) {
      throw new ErreurTransport('Média non initié', false, 'media-inconnu');
    }
    const fin = offset + morceau.byteLength;
    if (this.couperMediaApres !== null && fin > this.couperMediaApres) {
      this.couperMediaApres = null;
      etat.octets = offset;
      throw new ErreurTransport('Connexion interrompue', true, 'coupure');
    }
    etat.octets = fin;
    return { octetsRecus: etat.octets };
  }

  async completerMedia(mediaId: string): Promise<void> {
    if (this.checksumsARefuser.has(mediaId)) {
      this.checksumsARefuser.delete(mediaId);
      const etat = this.medias.get(mediaId);
      if (etat !== undefined) etat.octets = 0;
      throw new ErreurTransport(
        'Empreinte invalide',
        true,
        'checksum-invalide',
      );
    }
    const etat = this.medias.get(mediaId);
    if (etat !== undefined) etat.scelle = true;
  }
}

/** Lecteur de fichiers simulé : des octets déterministes, sans disque. */
export class FichiersSimules implements LecteurFichiers {
  readonly lectures: { chemin: string; offset: number; longueur: number }[] = [];

  async lire(chemin: string, offset: number, longueur: number): Promise<Uint8Array> {
    this.lectures.push({ chemin, offset, longueur });
    return new Uint8Array(longueur).fill(1);
  }
}
