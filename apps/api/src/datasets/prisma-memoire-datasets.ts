import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

interface LigneDataset {
  id: string;
  organizationId: string;
  name: string;
  label: string;
  version: number;
  entryCount: number;
  createdByUserId: string;
  updatedAt: Date;
}

interface LigneEntree {
  id: string;
  organizationId: string;
  datasetId: string;
  value: string;
  label: string;
  attributes: unknown;
  version: number;
  deletedAtVersion: number | null;
}

/** Filtres utilisés par le service : égalité, `in`, `gt`, et `null` explicite. */
function correspond(ligne: Record<string, unknown>, filtre: Record<string, unknown>): boolean {
  return Object.entries(filtre).every(([cle, attendu]) => {
    const valeur = ligne[cle];
    if (attendu !== null && typeof attendu === 'object') {
      const operateurs = attendu as { in?: unknown[]; gt?: number };
      if (operateurs.in !== undefined) return operateurs.in.includes(valeur);
      if (operateurs.gt !== undefined) {
        return typeof valeur === 'number' && valeur > operateurs.gt;
      }
    }
    return valeur === attendu;
  });
}

export class BasePrismaDatasets {
  readonly jeux: LigneDataset[] = [];
  readonly entrees: LigneEntree[] = [];

  readonly dataset = {
    create: async ({ data }: { data: Omit<LigneDataset, 'id' | 'version' | 'entryCount' | 'updatedAt'> }) => {
      const ligne: LigneDataset = {
        id: randomUUID(),
        version: 1,
        entryCount: 0,
        updatedAt: new Date(),
        ...data,
      };
      this.jeux.push(ligne);
      return ligne;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.jeux.find((j) => j.id === where.id) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.jeux.filter((j) => correspond(j as never, where)),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneDataset>;
    }) => {
      const ligne = this.jeux.find((j) => j.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data, { updatedAt: new Date() });
      return ligne ?? null;
    },
  };

  readonly datasetEntry = {
    create: async ({ data }: { data: Omit<LigneEntree, 'id'> }) => {
      const ligne: LigneEntree = { id: randomUUID(), ...data };
      this.entrees.push(ligne);
      return ligne;
    },
    findMany: async ({
      where,
      take,
      skip,
    }: {
      where: Record<string, unknown>;
      take?: number;
      skip?: number;
    }) => {
      const trouvees = this.entrees.filter((e) => correspond(e as never, where));
      const debut = skip ?? 0;
      return take === undefined ? trouvees : trouvees.slice(debut, debut + take);
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      this.entrees.filter((e) => correspond(e as never, where)).length,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneEntree>;
    }) => {
      const ligne = this.entrees.find((e) => e.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: { in: string[] } };
      data: Partial<LigneEntree>;
    }) => {
      let touchees = 0;
      for (const ligne of this.entrees) {
        if (!where.id.in.includes(ligne.id)) continue;
        Object.assign(ligne, data);
        touchees += 1;
      }
      return { count: touchees };
    },
  };

  enServicePrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
