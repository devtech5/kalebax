import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OffsetInvalideError,
  STOCKAGE_MEDIAS,
  type StockageMedias,
} from './stockage-medias.port.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SoumissionsService,
  type SoumissionEntrante,
} from '../soumissions/soumissions.service.js';
import type { ContexteAppelant } from '../tenant/contexte.js';
import { exigerAppartenance, porteeLecture } from '../tenant/portee.js';

export type EtatElement = 'recue' | 'deja' | 'refusee';

export interface ResultatElement {
  readonly id: string;
  readonly etat: EtatElement;
  readonly status?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface MediaAnnonce {
  readonly submissionId: string;
  readonly questionName: string;
  readonly kind: 'photo' | 'audio' | 'video' | 'signature' | 'file';
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly capturedAt?: string | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
}

@Injectable()
export class SyncService {
  private readonly journal = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soumissions: SoumissionsService,
    @Inject(STOCKAGE_MEDIAS) private readonly medias: StockageMedias,
  ) {}

  /**
   * Réception d'un lot — docs/synchronisation.md §5.2.
   *
   * **Le serveur ne fait pas tout ou rien.** Chaque élément a son propre
   * résultat : un lot partiellement traité est un succès partiel. Un
   * tout-ou-rien ferait rejouer indéfiniment un lot entier à cause d'une seule
   * soumission problématique — et c'est précisément celle-là qu'il ne faut pas
   * perdre.
   */
  async recevoirLot(
    contexte: ContexteAppelant,
    lot: readonly SoumissionEntrante[],
  ): Promise<ResultatElement[]> {
    const resultats: ResultatElement[] = [];

    for (const entrante of lot) {
      try {
        const recue = await this.soumissions.recevoir(contexte, entrante);
        resultats.push({
          id: entrante.id,
          etat: recue.deja ? 'deja' : 'recue',
          status: recue.status,
        });
      } catch (erreur) {
        // Une erreur sur un élément n'interrompt pas le lot : les autres
        // doivent pouvoir être confirmés.
        const refus = interpreterRefus(erreur);
        if (refus === null) throw erreur;
        this.journal.warn(`Soumission ${entrante.id} refusée : ${refus.code}`);
        resultats.push({ id: entrante.id, etat: 'refusee', ...refus });
      }
    }

    return resultats;
  }

  /**
   * Annonce un média et rend ce que le serveur détient déjà.
   *
   * C'est le serveur qui fait foi sur l'offset de reprise : un compteur local
   * divergerait au premier redémarrage brutal de l'appareil.
   */
  async initierMedia(
    contexte: ContexteAppelant,
    mediaId: string,
    annonce: MediaAnnonce,
  ): Promise<{ octetsRecus: number }> {
    const soumission = exigerAppartenance(
      contexte,
      await this.prisma.submission.findUnique({
        where: { id: annonce.submissionId },
        select: { id: true, organizationId: true },
      }),
      'Soumission',
    );

    const existant = await this.prisma.attachment.findUnique({
      where: { id: mediaId },
      select: { id: true, organizationId: true, uploadedAt: true, checksum: true },
    });

    if (existant !== null) {
      exigerAppartenance(contexte, existant, 'Pièce jointe');
      // Déjà scellée : inutile de la renvoyer.
      if (existant.uploadedAt !== null) {
        return { octetsRecus: annonce.sizeBytes };
      }
    } else {
      await this.prisma.attachment.create({
        data: {
          id: mediaId,
          organizationId: contexte.organizationId,
          submissionId: soumission.id,
          questionName: annonce.questionName,
          kind: annonce.kind,
          storageKey: cleStockage(contexte.organizationId, mediaId),
          mimeType: annonce.mimeType,
          sizeBytes: annonce.sizeBytes,
          checksum: annonce.checksum,
          capturedAt: annonce.capturedAt === undefined ? null : new Date(annonce.capturedAt),
          latitude: annonce.latitude ?? null,
          longitude: annonce.longitude ?? null,
        },
      });
    }

    const detenus = await this.medias.taille(cleStockage(contexte.organizationId, mediaId));
    return { octetsRecus: Math.min(detenus, annonce.sizeBytes) };
  }

  async recevoirMorceau(
    contexte: ContexteAppelant,
    mediaId: string,
    offset: number,
    morceau: Uint8Array,
  ): Promise<{ octetsRecus: number }> {
    const media = exigerAppartenance(
      contexte,
      await this.prisma.attachment.findUnique({ where: { id: mediaId } }),
      'Pièce jointe',
    );

    if (media.uploadedAt !== null) {
      return { octetsRecus: media.sizeBytes };
    }

    if (offset + morceau.byteLength > media.sizeBytes) {
      throw new BadRequestException(
        'Ce morceau dépasse la taille annoncée pour cette pièce jointe.',
      );
    }

    try {
      const octetsRecus = await this.medias.ecrireA(media.storageKey, offset, morceau);
      return { octetsRecus };
    } catch (erreur) {
      if (erreur instanceof OffsetInvalideError) {
        // On dit où reprendre plutôt que de refuser sèchement : l'appareil
        // corrige et poursuit au lieu de tout recommencer.
        throw new ConflictException({
          message: erreur.message,
          octetsRecus: erreur.attendu,
        });
      }
      throw erreur;
    }
  }

  /**
   * Scelle un média après vérification de son empreinte.
   *
   * Un fichier qui ne correspond pas à son SHA-256 est jeté et l'envoi
   * recommence : un média corrompu vaut moins que pas de média, car il fait
   * croire à une preuve.
   */
  async completerMedia(contexte: ContexteAppelant, mediaId: string): Promise<void> {
    const media = exigerAppartenance(
      contexte,
      await this.prisma.attachment.findUnique({ where: { id: mediaId } }),
      'Pièce jointe',
    );

    if (media.uploadedAt !== null) return;

    const detenus = await this.medias.taille(media.storageKey);
    if (detenus !== media.sizeBytes) {
      throw new ConflictException({
        message: 'Pièce jointe incomplète.',
        octetsRecus: detenus,
      });
    }

    const empreinte = await this.medias.empreinte(media.storageKey);
    if (empreinte !== media.checksum) {
      await this.medias.supprimer(media.storageKey);
      this.journal.warn(`Empreinte invalide pour la pièce jointe ${mediaId}.`);
      throw new BadRequestException({
        message: "Cette pièce jointe est arrivée abîmée et a été refusée.",
        code: 'checksum-invalide',
      });
    }

    await this.prisma.attachment.update({
      where: { id: mediaId },
      data: { uploadedAt: new Date() },
    });
  }

  /**
   * Paquet descendant — docs/synchronisation.md §7.
   *
   * Différentiel : l'appareil annonce les versions qu'il détient, le serveur ne
   * renvoie que ce qui manque. Retélécharger l'ensemble à chaque
   * synchronisation serait inacceptable sur un réseau facturé au mégaoctet.
   */
  async paquet(
    contexte: ContexteAppelant,
    projectId: string,
    versionsDetenues: readonly string[],
  ) {
    // Un membre révoqué envoie ce qu'il a collecté, mais ne reçoit plus rien.
    if (contexte.revoque) {
      throw new ForbiddenException(
        "Votre accès à cette organisation a été retiré : aucune nouvelle mission ne peut être téléchargée.",
      );
    }

    exigerAppartenance(
      contexte,
      await this.prisma.project.findUnique({ where: { id: projectId } }),
      'Projet',
    );

    const detenues = new Set(versionsDetenues);
    // Une version en brouillon ne descend jamais : rien n'a pu en sortir
    // légitimement, et la publier à un agent l'exposerait à collecter sur un
    // formulaire non figé.
    // Tableau mutable : Prisma refuse un `readonly` dans un filtre `in`.
    const publiables: ('published' | 'retired')[] = ['published', 'retired'];
    const versions = await this.prisma.formVersion.findMany({
      where: porteeLecture(contexte, { status: { in: publiables } }),
      select: {
        id: true,
        formId: true,
        versionNumber: true,
        status: true,
        schema: true,
        form: { select: { projectId: true, name: true } },
      },
    });

    const duProjet = versions.filter((v) => v.form.projectId === projectId);

    return {
      versions: duProjet
        .filter((v) => !detenues.has(v.id))
        .map((v) => ({
          id: v.id,
          formId: v.formId,
          formName: v.form.name,
          versionNumber: v.versionNumber,
          status: v.status,
          schema: v.schema,
        })),
      // Ce que l'appareil peut oublier : plus rien ne le publie, et aucune
      // soumission locale ne devrait s'y rattacher.
      versionsObsoletes: [...detenues].filter(
        (id) => !duProjet.some((v) => v.id === id),
      ),
    };
  }

  /**
   * Diagnostic de terrain.
   *
   * Quand un agent affirme avoir tout envoyé et que le superviseur ne voit
   * rien, il faut pouvoir trancher depuis l'appareil, sans accès à la base.
   */
  async etat(contexte: ContexteAppelant, ids: readonly string[]) {
    if (ids.length === 0) return { connues: [], inconnues: [] };

    const connues = await this.prisma.submission.findMany({
      where: porteeLecture(contexte, { id: { in: [...ids] } }),
      select: { id: true, status: true, receivedAt: true, revision: true },
    });

    const vues = new Set(connues.map((s) => s.id));
    return {
      connues,
      inconnues: ids.filter((id) => !vues.has(id)),
    };
  }
}

/** Les médias sont rangés par organisation : l'isolement vaut aussi sur disque. */
function cleStockage(organizationId: string, mediaId: string): string {
  return `${organizationId}/${mediaId}`;
}

/**
 * Traduit une exception en refus d'élément, ou rend `null` si l'erreur doit
 * interrompre tout le lot.
 */
function interpreterRefus(
  erreur: unknown,
): { code: string; message: string } | null {
  if (erreur instanceof NotFoundException) {
    return {
      code: 'version-inconnue',
      message: "La version de formulaire de cette soumission est introuvable.",
    };
  }
  if (erreur instanceof BadRequestException) {
    return {
      code: 'version-non-publiee',
      message: "Cette version de formulaire n'accepte pas de soumission.",
    };
  }
  // Organisation suspendue, panne de base : l'appareil doit réessayer plus
  // tard, pas marquer ses données en échec définitif.
  return null;
}
