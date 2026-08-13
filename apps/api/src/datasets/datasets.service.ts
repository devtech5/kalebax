import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { auMoins, type ContexteAppelant } from '../tenant/contexte.js';
import {
  exigerActif,
  exigerAppartenance,
  porteeCreation,
  porteeLecture,
} from '../tenant/portee.js';

/** Limites — docs/jeux-donnees.md §7. */
export const LIMITES_DATASET = {
  entreesParJeu: 50_000,
  longueurValeur: 200,
  attributsParEntree: 20,
} as const;

export interface EntreeImport {
  readonly value: string;
  readonly label: string;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface RapportImport {
  readonly version: number;
  readonly ajoutees: number;
  readonly modifiees: number;
  readonly retirees: number;
  readonly inchangees: number;
  /** Faux quand rien n'a changé : la version n'a alors pas bougé. */
  readonly versionIncrementee: boolean;
}

export interface DeltaDataset {
  readonly nom: string;
  readonly version: number;
  readonly mode: 'delta' | 'complet';
  readonly ajoutees: readonly {
    value: string;
    label: string;
    attributes: unknown;
  }[];
  readonly retirees: readonly string[];
}

/**
 * Au-delà de cette proportion, un différentiel pèse plus lourd que le jeu
 * entier : un appareil qui revient après six semaines reçoit l'intégral.
 */
const SEUIL_ENVOI_COMPLET = 0.6;

@Injectable()
export class DatasetsService {
  constructor(private readonly prisma: PrismaService) {}

  async creer(
    contexte: ContexteAppelant,
    donnees: { name: string; label: string },
  ) {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    if (!/^[a-z_][a-z0-9_]*$/.test(donnees.name)) {
      throw new BadRequestException(
        "Le nom technique s'écrit en minuscules sans accent, et ne contient que des lettres, des chiffres et des tirets bas.",
      );
    }

    return this.prisma.dataset.create({
      data: porteeCreation(contexte, {
        name: donnees.name,
        label: donnees.label,
        createdByUserId: contexte.userId,
      }),
    });
  }

  async lister(contexte: ContexteAppelant) {
    return this.prisma.dataset.findMany({
      where: porteeLecture(contexte),
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        label: true,
        version: true,
        entryCount: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Remplace le contenu d'un jeu de données — docs/jeux-donnees.md §4.
   *
   * Les entrées identiques ne sont pas touchées : les réécrire produirait un
   * delta complet à chaque import et annulerait tout l'intérêt du différentiel.
   */
  async importer(
    contexte: ContexteAppelant,
    datasetId: string,
    entrees: readonly EntreeImport[],
  ): Promise<RapportImport> {
    exigerActif(contexte);
    this.exigerConcepteur(contexte);

    const jeu = exigerAppartenance(
      contexte,
      await this.prisma.dataset.findUnique({ where: { id: datasetId } }),
      'Jeu de données',
    );

    this.verifierEntrees(entrees);

    const existantes = await this.prisma.datasetEntry.findMany({
      where: { datasetId },
    });
    const parValeur = new Map(existantes.map((e) => [e.value, e]));
    const nouvellesValeurs = new Set(entrees.map((e) => e.value));

    const prochaine = jeu.version + 1;
    const aCreer: EntreeImport[] = [];
    const aModifier: { id: string; entree: EntreeImport }[] = [];
    const aRetirer: string[] = [];
    let inchangees = 0;

    for (const entree of entrees) {
      const existante = parValeur.get(entree.value);
      if (existante === undefined) {
        aCreer.push(entree);
        continue;
      }

      const identique =
        existante.label === entree.label &&
        existante.deletedAtVersion === null &&
        JSON.stringify(existante.attributes ?? null) ===
          JSON.stringify(entree.attributes ?? null);

      if (identique) {
        inchangees += 1;
        continue;
      }
      // Une entrée retirée puis réintroduite reprend la même ligne : en créer
      // une seconde casserait l'unicité et l'historique.
      aModifier.push({ id: existante.id, entree });
    }

    for (const existante of existantes) {
      if (existante.deletedAtVersion !== null) continue;
      if (nouvellesValeurs.has(existante.value)) continue;
      aRetirer.push(existante.id);
    }

    const rienNeChange =
      aCreer.length === 0 && aModifier.length === 0 && aRetirer.length === 0;

    // Sans cette garde, un rafraîchissement quotidien automatique ferait
    // retélécharger un delta vide à tous les appareils, chaque jour.
    if (rienNeChange) {
      return {
        version: jeu.version,
        ajoutees: 0,
        modifiees: 0,
        retirees: 0,
        inchangees,
        versionIncrementee: false,
      };
    }

    for (const entree of aCreer) {
      await this.prisma.datasetEntry.create({
        data: {
          organizationId: contexte.organizationId,
          datasetId,
          value: entree.value,
          label: entree.label,
          attributes: (entree.attributes ?? null) as object,
          version: prochaine,
          deletedAtVersion: null,
        },
      });
    }

    for (const { id, entree } of aModifier) {
      await this.prisma.datasetEntry.update({
        where: { id },
        data: {
          label: entree.label,
          attributes: (entree.attributes ?? null) as object,
          version: prochaine,
          deletedAtVersion: null,
        },
      });
    }

    if (aRetirer.length > 0) {
      await this.prisma.datasetEntry.updateMany({
        where: { id: { in: aRetirer } },
        data: { deletedAtVersion: prochaine },
      });
    }

    await this.prisma.dataset.update({
      where: { id: datasetId },
      data: { version: prochaine, entryCount: entrees.length },
    });

    return {
      version: prochaine,
      ajoutees: aCreer.length,
      modifiees: aModifier.length,
      retirees: aRetirer.length,
      inchangees,
      versionIncrementee: true,
    };
  }

  /** Entrées vivantes, paginées, pour la console. */
  async listerEntrees(contexte: ContexteAppelant, datasetId: string, limite = 100, decalage = 0) {
    exigerAppartenance(
      contexte,
      await this.prisma.dataset.findUnique({ where: { id: datasetId } }),
      'Jeu de données',
    );

    return this.prisma.datasetEntry.findMany({
      where: { datasetId, deletedAtVersion: null },
      orderBy: { value: 'asc' },
      take: Math.min(limite, 1000),
      skip: decalage,
      select: { value: true, label: true, attributes: true },
    });
  }

  /**
   * Différentiel depuis la version détenue par l'appareil.
   *
   * Une entrée modifiée apparaît dans `ajoutees` : l'appareil remplace par
   * valeur, il n'a pas besoin de distinguer un ajout d'une modification.
   */
  async delta(
    contexte: ContexteAppelant,
    versionsDetenues: Readonly<Record<string, number>>,
  ): Promise<DeltaDataset[]> {
    const jeux = await this.prisma.dataset.findMany({
      where: porteeLecture(contexte),
    });

    const deltas: DeltaDataset[] = [];

    for (const jeu of jeux) {
      const detenue = versionsDetenues[jeu.name] ?? 0;
      if (detenue >= jeu.version) continue;

      const modifiees = await this.prisma.datasetEntry.count({
        where: { datasetId: jeu.id, version: { gt: detenue } },
      });

      // Au-delà du seuil, le différentiel pèserait plus lourd que le jeu entier.
      const complet =
        detenue === 0 || modifiees > Math.max(jeu.entryCount, 1) * SEUIL_ENVOI_COMPLET;

      if (complet) {
        const vivantes = await this.prisma.datasetEntry.findMany({
          where: { datasetId: jeu.id, deletedAtVersion: null },
          select: { value: true, label: true, attributes: true },
        });
        deltas.push({
          nom: jeu.name,
          version: jeu.version,
          mode: 'complet',
          ajoutees: vivantes,
          retirees: [],
        });
        continue;
      }

      const ajoutees = await this.prisma.datasetEntry.findMany({
        where: { datasetId: jeu.id, version: { gt: detenue }, deletedAtVersion: null },
        select: { value: true, label: true, attributes: true },
      });
      const retirees = await this.prisma.datasetEntry.findMany({
        where: { datasetId: jeu.id, deletedAtVersion: { gt: detenue } },
        select: { value: true },
      });

      deltas.push({
        nom: jeu.name,
        version: jeu.version,
        mode: 'delta',
        ajoutees,
        retirees: retirees.map((e) => e.value),
      });
    }

    return deltas;
  }

  /**
   * Valeurs acceptables par nom de jeu, pour la validation des soumissions.
   *
   * Les entrées retirées en font partie : l'agent les a choisies alors qu'elles
   * existaient, et les refuser lui reprocherait le temps qui passe.
   */
  async valeursAutorisees(
    contexte: ContexteAppelant,
    noms: readonly string[],
  ): Promise<Record<string, Set<string>>> {
    if (noms.length === 0) return {};

    const jeux = await this.prisma.dataset.findMany({
      where: porteeLecture(contexte, { name: { in: [...noms] } }),
      select: { id: true, name: true },
    });

    const valeurs: Record<string, Set<string>> = {};
    for (const jeu of jeux) {
      const entrees = await this.prisma.datasetEntry.findMany({
        where: { datasetId: jeu.id },
        select: { value: true },
      });
      valeurs[jeu.name] = new Set(entrees.map((e) => e.value));
    }
    return valeurs;
  }

  private verifierEntrees(entrees: readonly EntreeImport[]): void {
    if (entrees.length > LIMITES_DATASET.entreesParJeu) {
      throw new BadRequestException(
        `Ce jeu compte ${entrees.length} entrées pour un maximum de ${LIMITES_DATASET.entreesParJeu} : au-delà, le filtrage devient trop lent sur un téléphone d'entrée de gamme.`,
      );
    }

    const vues = new Set<string>();
    for (const entree of entrees) {
      if (entree.value.length > LIMITES_DATASET.longueurValeur) {
        throw new BadRequestException(
          `La valeur « ${entree.value.slice(0, 40)}… » dépasse ${LIMITES_DATASET.longueurValeur} caractères ; elle finirait en colonne d'export.`,
        );
      }
      if (vues.has(entree.value)) {
        throw new BadRequestException(
          `La valeur « ${entree.value} » apparaît deux fois dans l'import.`,
        );
      }
      vues.add(entree.value);

      const attributs = Object.keys(entree.attributes ?? {});
      if (attributs.length > LIMITES_DATASET.attributsParEntree) {
        throw new BadRequestException(
          `L'entrée « ${entree.value} » porte ${attributs.length} attributs : un référentiel n'est pas une base de données.`,
        );
      }
      for (const [cle, valeur] of Object.entries(entree.attributes ?? {})) {
        const type = typeof valeur;
        if (valeur !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
          throw new BadRequestException(
            `L'attribut « ${cle} » de « ${entree.value} » doit être une valeur simple : le filtrage en cascade ne sait pas parcourir une structure imbriquée.`,
          );
        }
      }
    }
  }

  private exigerConcepteur(contexte: ContexteAppelant): void {
    if (!auMoins(contexte.role, 'designer')) {
      throw new NotFoundException('Ressource introuvable.');
    }
  }
}
