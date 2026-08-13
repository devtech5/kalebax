import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  comparerVersions,
  validerDocument,
  type DocumentFormulaire,
  type RapportComparaison,
} from '@kalebax/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { auMoins, type ContexteAppelant } from '../tenant/contexte.js';
import {
  exigerActif,
  exigerAppartenance,
  porteeCreation,
  porteeLecture,
} from '../tenant/portee.js';

/**
 * Statuts de version, en littéraux typés.
 *
 * Prisma exige ses propres énumérations : une chaîne nue ne compile pas, ce qui
 * est une bonne chose — une faute de frappe dans un statut passerait sinon
 * inaperçue jusqu'à produire une requête qui ne remonte jamais rien.
 */
const BROUILLON = 'draft' as const;
const PUBLIEE = 'published' as const;
const RETIREE = 'retired' as const;

export interface ResultatPublication {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly breakingChange: boolean;
  readonly comparaison: RapportComparaison | null;
  /** Nombre de soumissions déjà reçues, pour éclairer l'avertissement au concepteur. */
  readonly soumissionsExistantes: number;
}

@Injectable()
export class FormulairesService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------ projets */

  async creerProjet(
    contexte: ContexteAppelant,
    donnees: {
      name: string;
      description?: string | undefined;
      purpose?: string | undefined;
    },
  ) {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    return this.prisma.project.create({
      data: porteeCreation(contexte, {
        name: donnees.name,
        // Un champ non renseigné est un NULL en base, pas une absence de
        // colonne : la distinction compte pour Prisma.
        description: donnees.description ?? null,
        purpose: donnees.purpose ?? null,
        createdByUserId: contexte.userId,
      }),
    });
  }

  async listerProjets(contexte: ContexteAppelant) {
    return this.prisma.project.findMany({
      where: porteeLecture(contexte),
      orderBy: { createdAt: 'desc' },
    });
  }

  /* -------------------------------------------------------- formulaires */

  /**
   * Crée un formulaire et sa première version, en brouillon.
   *
   * Le document n'est pas validé ici : un brouillon se construit par petites
   * touches, et refuser une sauvegarde intermédiaire ferait perdre du travail.
   * La validation a lieu à la publication.
   */
  async creerFormulaire(
    contexte: ContexteAppelant,
    projectId: string,
    donnees: { name: string; schema?: unknown },
  ) {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    exigerAppartenance(
      contexte,
      await this.prisma.project.findUnique({ where: { id: projectId } }),
      'Projet',
    );

    const formulaire = await this.prisma.form.create({
      data: porteeCreation(contexte, {
        projectId,
        name: donnees.name,
        createdByUserId: contexte.userId,
      }),
    });

    await this.prisma.formVersion.create({
      data: porteeCreation(contexte, {
        formId: formulaire.id,
        versionNumber: 1,
        schema: (donnees.schema ?? documentVide(donnees.name)) as object,
        status: BROUILLON,
      }),
    });

    return formulaire;
  }

  async listerVersions(contexte: ContexteAppelant, formId: string) {
    exigerAppartenance(
      contexte,
      await this.prisma.form.findUnique({ where: { id: formId } }),
      'Formulaire',
    );

    return this.prisma.formVersion.findMany({
      where: porteeLecture(contexte, { formId }),
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        breakingChange: true,
        publishedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Modifie le document d'une version.
   *
   * **Une version publiée n'est jamais modifiable**, y compris par le
   * propriétaire de l'organisation : corriger, c'est publier une version
   * suivante. C'est la condition de crédibilité des données déjà collectées.
   */
  async modifierVersion(contexte: ContexteAppelant, versionId: string, schema: unknown) {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    const version = exigerAppartenance(
      contexte,
      await this.prisma.formVersion.findUnique({ where: { id: versionId } }),
      'Version',
    );

    if (version.status !== BROUILLON) {
      throw new ConflictException(
        'Cette version est publiée : elle ne peut plus être modifiée. Créez une nouvelle version pour apporter des corrections.',
      );
    }

    return this.prisma.formVersion.update({
      where: { id: versionId },
      data: { schema: schema as object },
    });
  }

  /**
   * Valide le document puis publie la version.
   *
   * Une erreur d'expression découverte par un agent à 300 km du bureau est un
   * échec produit : tout ce qui peut être détecté ici l'est, et bloque.
   */
  async publierVersion(
    contexte: ContexteAppelant,
    versionId: string,
  ): Promise<ResultatPublication> {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    const version = exigerAppartenance(
      contexte,
      await this.prisma.formVersion.findUnique({ where: { id: versionId } }),
      'Version',
    );

    if (version.status !== BROUILLON) {
      throw new ConflictException('Cette version est déjà publiée.');
    }

    const validation = validerDocument(version.schema);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'Ce formulaire comporte des erreurs et ne peut pas être publié.',
        anomalies: validation.anomalies,
      });
    }

    const precedente = await this.prisma.formVersion.findFirst({
      where: porteeLecture(contexte, {
        formId: version.formId,
        status: { in: [PUBLIEE, RETIREE] },
      }),
      orderBy: { versionNumber: 'desc' },
    });

    let comparaison: RapportComparaison | null = null;
    if (precedente !== null) {
      const ancienne = validerDocument(precedente.schema);
      // Une version publiée a forcément été validée : si elle ne l'est plus,
      // c'est que le format a évolué, et on ne compare pas à l'aveugle.
      if (ancienne.ok) {
        comparaison = comparerVersions(ancienne.document, validation.document);
      }
    }

    const soumissionsExistantes = await this.prisma.submission.count({
      where: porteeLecture(contexte, { formVersionId: precedente?.id ?? '' }),
    });

    const publiee = await this.prisma.formVersion.update({
      where: { id: versionId },
      data: {
        status: PUBLIEE,
        breakingChange: comparaison?.breakingChange ?? false,
        publishedAt: new Date(),
        publishedByUserId: contexte.userId,
      },
    });

    // L'ancienne version passe en retrait, sans jamais être supprimée : les
    // brouillons commencés dessus restent soumettables.
    if (precedente !== null) {
      await this.prisma.formVersion.update({
        where: { id: precedente.id },
        data: { status: RETIREE },
      });
    }

    await this.prisma.form.update({
      where: { id: version.formId },
      data: { currentVersionId: publiee.id },
    });

    return {
      versionId: publiee.id,
      versionNumber: publiee.versionNumber,
      breakingChange: publiee.breakingChange,
      comparaison,
      soumissionsExistantes,
    };
  }

  /** Duplique la version courante en un nouveau brouillon. */
  async nouvelleVersion(contexte: ContexteAppelant, formId: string) {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    exigerAppartenance(
      contexte,
      await this.prisma.form.findUnique({ where: { id: formId } }),
      'Formulaire',
    );

    const brouillon = await this.prisma.formVersion.findFirst({
      where: porteeLecture(contexte, { formId, status: BROUILLON }),
    });
    if (brouillon !== null) {
      throw new ConflictException(
        'Un brouillon existe déjà pour ce formulaire : modifiez-le plutôt que d\'en créer un second.',
      );
    }

    const derniere = await this.prisma.formVersion.findFirst({
      where: porteeLecture(contexte, { formId }),
      orderBy: { versionNumber: 'desc' },
    });
    if (derniere === null) {
      throw new NotFoundException('Formulaire introuvable.');
    }

    return this.prisma.formVersion.create({
      data: porteeCreation(contexte, {
        formId,
        versionNumber: derniere.versionNumber + 1,
        schema: derniere.schema as object,
        status: BROUILLON,
      }),
    });
  }

  /** Document de la version publiée en cours, tel que l'application le télécharge. */
  async documentCourant(
    contexte: ContexteAppelant,
    formId: string,
  ): Promise<DocumentFormulaire> {
    const formulaire = exigerAppartenance(
      contexte,
      await this.prisma.form.findUnique({
        where: { id: formId },
        include: { currentVersion: true },
      }),
      'Formulaire',
    );

    if (formulaire.currentVersion === null) {
      throw new NotFoundException("Ce formulaire n'a pas encore de version publiée.");
    }

    return formulaire.currentVersion.schema as unknown as DocumentFormulaire;
  }

  private exigerConcepteur(contexte: ContexteAppelant): void {
    if (!auMoins(contexte.role, 'designer')) {
      throw new NotFoundException('Ressource introuvable.');
    }
  }
}

function documentVide(titre: string): DocumentFormulaire {
  return {
    schemaVersion: 1,
    title: { fr: titre },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children: [],
  };
}
