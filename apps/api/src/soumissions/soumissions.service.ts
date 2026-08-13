import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  datasetsReferences,
  validerSoumission,
  type DocumentFormulaire,
} from '@kalebax/shared';
import { DatasetsService } from '../datasets/datasets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  peutVoirToutesLesSoumissions,
  type ContexteAppelant,
} from '../tenant/contexte.js';
import { exigerActif, exigerAppartenance, porteeLecture } from '../tenant/portee.js';

export interface SoumissionEntrante {
  /** UUID généré côté client, hors ligne. */
  readonly id: string;
  readonly formVersionId: string;
  readonly data: Record<string, unknown>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly deviceId?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly startLatitude?: number | undefined;
  readonly startLongitude?: number | undefined;
  readonly startAccuracy?: number | undefined;
  readonly startGeopointStatus?:
    | 'captured'
    | 'denied'
    | 'unavailable'
    | 'timeout'
    | 'skipped'
    | undefined;
}

export interface ResultatReception {
  readonly id: string;
  readonly status: string;
  /** Vrai si la soumission existait déjà : la requête n'a rien modifié. */
  readonly deja: boolean;
  readonly violations: readonly unknown[];
}

@Injectable()
export class SoumissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly datasets: DatasetsService,
  ) {}

  /**
   * Réception d'une soumission — docs/formulaires.md §8.
   *
   * Idempotente sur l'identifiant : rejouer une synchronisation interrompue ne
   * duplique jamais une soumission, et ne modifie jamais celle qui existe.
   */
  async recevoir(
    contexte: ContexteAppelant,
    entrante: SoumissionEntrante,
  ): Promise<ResultatReception> {
    // Un membre révoqué garde le droit d'envoyer ce qu'il a déjà collecté :
    // `exigerActif` n'est délibérément pas appelé ici.

    const existante = await this.prisma.submission.findUnique({
      where: { id: entrante.id },
      select: { id: true, organizationId: true, status: true, violations: true },
    });

    if (existante !== null) {
      // Un identifiant déjà pris dans une autre organisation reste introuvable
      // ici : le signaler révélerait son existence ailleurs.
      exigerAppartenance(contexte, existante, 'Soumission');
      return {
        id: existante.id,
        status: existante.status,
        deja: true,
        violations: (existante.violations as unknown[] | null) ?? [],
      };
    }

    const version = exigerAppartenance(
      contexte,
      await this.prisma.formVersion.findUnique({
        where: { id: entrante.formVersionId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          schema: true,
          form: { select: { projectId: true } },
        },
      }),
      'Version de formulaire',
    );

    // Une version en brouillon n'a jamais été publiée : aucune donnée n'a pu
    // en sortir légitimement.
    if (version.status === 'draft') {
      throw new BadRequestException(
        "Cette version de formulaire n'est pas publiée : aucune soumission ne peut s'y rattacher.",
      );
    }

    const document = version.schema as unknown as DocumentFormulaire;

    // Le serveur a le document et les référentiels ; l'appareil n'a que le
    // document. C'est donc ici qu'une valeur de jeu de données est vérifiable.
    const valeursDataset = await this.datasets.valeursAutorisees(
      contexte,
      datasetsReferences(document),
    );

    const rapport = validerSoumission(document, entrante.data, {
      now: entrante.startedAt,
      valeursDataset,
    });

    const debut = new Date(entrante.startedAt);
    const fin = new Date(entrante.completedAt);
    const duree = Math.max(0, Math.round((fin.getTime() - debut.getTime()) / 1000));

    const creee = await this.prisma.submission.create({
      data: {
        id: entrante.id,
        organizationId: contexte.organizationId,
        projectId: version.form.projectId,
        formVersionId: version.id,
        data: entrante.data as object,
        extraData: rapport.extraData as object,
        // Une soumission en échec est enregistrée quand même : perdre une
        // donnée de terrain est pire que la conserver pour arbitrage humain.
        violations: rapport.violations as unknown as object,
        status: rapport.valide ? 'received' : 'rejected',
        revision: 1,
        collectedByUserId: contexte.userId,
        startedAt: debut,
        completedAt: fin,
        durationSeconds: duree,
        deviceId: entrante.deviceId ?? null,
        appVersion: entrante.appVersion ?? null,
        startLatitude: entrante.startLatitude ?? null,
        startLongitude: entrante.startLongitude ?? null,
        startAccuracy: entrante.startAccuracy ?? null,
        startGeopointStatus: entrante.startGeopointStatus ?? null,
      },
      select: { id: true, status: true },
    });

    // La révision 1 est écrite à la réception : l'état d'origine, tel que
    // l'agent l'a soumis, reste toujours récupérable quoi qu'il arrive ensuite.
    await this.prisma.submissionRevision.create({
      data: {
        submissionId: creee.id,
        revision: 1,
        data: entrante.data as object,
        changedFields: {} as object,
        reason: 'Réception initiale',
        changedByUserId: contexte.userId,
      },
    });

    return {
      id: creee.id,
      status: creee.status,
      deja: false,
      violations: rapport.violations,
    };
  }

  /** Un agent ne lit jamais les soumissions d'un autre agent. */
  async lister(contexte: ContexteAppelant, projectId?: string) {
    const filtre: Record<string, unknown> = {};
    if (projectId !== undefined) filtre['projectId'] = projectId;
    if (!peutVoirToutesLesSoumissions(contexte.role)) {
      filtre['collectedByUserId'] = contexte.userId;
    }

    return this.prisma.submission.findMany({
      where: porteeLecture(contexte, filtre),
      orderBy: { receivedAt: 'desc' },
      select: {
        id: true,
        status: true,
        revision: true,
        receivedAt: true,
        startedAt: true,
        durationSeconds: true,
        collectedByUserId: true,
        formVersionId: true,
        startGeopointStatus: true,
      },
    });
  }

  /**
   * Correction d'une soumission.
   *
   * Une donnée collectée n'est jamais écrasée silencieusement : la correction
   * crée une révision horodatée et attribuée. C'est la condition de
   * crédibilité scientifique du produit.
   */
  async corriger(
    contexte: ContexteAppelant,
    submissionId: string,
    donnees: Record<string, unknown>,
    motif?: string,
  ) {
    exigerActif(contexte);
    if (!peutVoirToutesLesSoumissions(contexte.role)) {
      throw new NotFoundException('Soumission introuvable.');
    }

    const soumission = exigerAppartenance(
      contexte,
      await this.prisma.submission.findUnique({ where: { id: submissionId } }),
      'Soumission',
    );

    const avant = soumission.data as Record<string, unknown>;
    const changements = comparerDonnees(avant, donnees);
    if (Object.keys(changements).length === 0) {
      return { id: soumission.id, revision: soumission.revision, changements: {} };
    }

    const revision = soumission.revision + 1;

    await this.prisma.submission.update({
      where: { id: submissionId },
      data: { data: donnees as object, revision },
    });

    await this.prisma.submissionRevision.create({
      data: {
        submissionId,
        revision,
        data: donnees as object,
        changedFields: changements as object,
        reason: motif ?? null,
        changedByUserId: contexte.userId,
      },
    });

    return { id: submissionId, revision, changements };
  }

  async revisions(contexte: ContexteAppelant, submissionId: string) {
    exigerAppartenance(
      contexte,
      await this.prisma.submission.findUnique({ where: { id: submissionId } }),
      'Soumission',
    );

    return this.prisma.submissionRevision.findMany({
      where: { submissionId },
      orderBy: { revision: 'asc' },
    });
  }
}

/** `{ champ: { avant, apres } }` — seuls les champs réellement modifiés. */
function comparerDonnees(
  avant: Record<string, unknown>,
  apres: Record<string, unknown>,
): Record<string, { avant: unknown; apres: unknown }> {
  const changements: Record<string, { avant: unknown; apres: unknown }> = {};
  for (const cle of new Set([...Object.keys(avant), ...Object.keys(apres)])) {
    if (JSON.stringify(avant[cle]) !== JSON.stringify(apres[cle])) {
      changements[cle] = { avant: avant[cle] ?? null, apres: apres[cle] ?? null };
    }
  }
  return changements;
}
