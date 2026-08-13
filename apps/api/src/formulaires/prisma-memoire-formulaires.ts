import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Base en mémoire pour les tests de formulaires.
 *
 * Les règles à vérifier ici — immuabilité d'une version publiée, isolation
 * multi-tenant, détection des ruptures — ne dépendent pas de PostgreSQL. Les
 * lier à un conteneur qui tourne les rendrait testées trop tard et trop peu.
 */

interface LigneProjet {
  id: string;
  organizationId: string;
  name: string;
  description?: string | undefined;
  purpose?: string | undefined;
  createdByUserId: string;
  createdAt: Date;
}

interface LigneFormulaire {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  currentVersionId: string | null;
  createdByUserId: string;
  createdAt: Date;
}

interface LigneVersion {
  id: string;
  organizationId: string;
  formId: string;
  versionNumber: number;
  schema: unknown;
  status: string;
  breakingChange: boolean;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  createdAt: Date;
}

interface LigneSoumission {
  organizationId: string;
  formVersionId: string;
}

/** Applique un filtre plat, avec le seul opérateur utilisé par les services. */
function correspond(ligne: Record<string, unknown>, filtre: Record<string, unknown>): boolean {
  return Object.entries(filtre).every(([cle, attendu]) => {
    const valeur = ligne[cle];
    if (attendu !== null && typeof attendu === 'object' && 'in' in attendu) {
      return (attendu.in as unknown[]).includes(valeur);
    }
    return valeur === attendu;
  });
}

export class BasePrismaFormulaires {
  readonly projects: LigneProjet[] = [];
  readonly forms: LigneFormulaire[] = [];
  readonly formVersions: LigneVersion[] = [];
  readonly submissions: LigneSoumission[] = [];

  readonly project = {
    create: async ({ data }: { data: Omit<LigneProjet, 'id' | 'createdAt'> }) => {
      const ligne: LigneProjet = { id: randomUUID(), createdAt: new Date(), ...data };
      this.projects.push(ligne);
      return ligne;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.projects.find((p) => p.id === where.id) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.projects.filter((p) => correspond(p as never, where)),
  };

  readonly form = {
    create: async ({ data }: { data: Omit<LigneFormulaire, 'id' | 'createdAt' | 'currentVersionId'> }) => {
      const ligne: LigneFormulaire = {
        id: randomUUID(),
        currentVersionId: null,
        createdAt: new Date(),
        ...data,
      };
      this.forms.push(ligne);
      return ligne;
    },
    findUnique: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { currentVersion?: boolean };
    }) => {
      const ligne = this.forms.find((f) => f.id === where.id);
      if (ligne === undefined) return null;
      if (include?.currentVersion !== true) return ligne;
      return {
        ...ligne,
        currentVersion:
          this.formVersions.find((v) => v.id === ligne.currentVersionId) ?? null,
      };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneFormulaire>;
    }) => {
      const ligne = this.forms.find((f) => f.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
  };

  readonly formVersion = {
    create: async ({
      data,
    }: {
      data: Omit<LigneVersion, 'id' | 'createdAt' | 'breakingChange' | 'publishedAt' | 'publishedByUserId'>;
    }) => {
      const ligne: LigneVersion = {
        id: randomUUID(),
        breakingChange: false,
        publishedAt: null,
        publishedByUserId: null,
        createdAt: new Date(),
        ...data,
      };
      this.formVersions.push(ligne);
      return ligne;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.formVersions.find((v) => v.id === where.id) ?? null,
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: { versionNumber?: 'asc' | 'desc' };
    }) => {
      const trouvees = this.formVersions.filter((v) => correspond(v as never, where));
      if (orderBy?.versionNumber === 'desc') {
        trouvees.sort((a, b) => b.versionNumber - a.versionNumber);
      }
      return trouvees[0] ?? null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.formVersions.filter((v) => correspond(v as never, where)),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneVersion>;
    }) => {
      const ligne = this.formVersions.find((v) => v.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
  };

  readonly submission = {
    count: async ({ where }: { where: Record<string, unknown> }) =>
      this.submissions.filter((s) => correspond(s as never, where)).length,
  };

  enServicePrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
