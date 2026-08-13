import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Base en mémoire pour les tests de soumissions.
 *
 * Idempotence, immuabilité, isolation : ce sont les règles dont une défaillance
 * coûte des données de terrain irrécupérables. Elles doivent pouvoir être
 * rejouées à chaque modification, sans conteneur à démarrer.
 */

interface LigneVersion {
  id: string;
  organizationId: string;
  status: string;
  schema: unknown;
  projectId: string;
}

interface LigneSoumission {
  id: string;
  organizationId: string;
  projectId: string;
  formVersionId: string;
  data: Record<string, unknown>;
  extraData: unknown;
  violations: unknown;
  status: string;
  revision: number;
  collectedByUserId: string;
  startedAt: Date;
  completedAt: Date;
  receivedAt: Date;
  durationSeconds: number;
  deviceId: string | null;
  appVersion: string | null;
  startLatitude: number | null;
  startLongitude: number | null;
  startAccuracy: number | null;
  startGeopointStatus: string | null;
}

interface LigneRevision {
  id: string;
  submissionId: string;
  revision: number;
  data: unknown;
  changedFields: unknown;
  reason: string | null;
  changedByUserId: string;
  changedAt: Date;
}

/** Égalité simple, plus l'opérateur `in` — les seuls filtres que les services utilisent. */
function correspond(ligne: Record<string, unknown>, filtre: Record<string, unknown>): boolean {
  return Object.entries(filtre).every(([cle, attendu]) => {
    if (attendu !== null && typeof attendu === 'object' && 'in' in attendu) {
      return (attendu.in as unknown[]).includes(ligne[cle]);
    }
    return ligne[cle] === attendu;
  });
}

export class BasePrismaSoumissions {
  readonly versions: LigneVersion[] = [];
  readonly soumissions: LigneSoumission[] = [];
  readonly revisionsEnregistrees: LigneRevision[] = [];

  readonly formVersion = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const ligne = this.versions.find((v) => v.id === where.id);
      if (ligne === undefined) return null;
      return { ...ligne, form: { projectId: ligne.projectId } };
    },
  };

  readonly submission = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.soumissions.find((s) => s.id === where.id) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.soumissions.filter((s) => correspond(s as never, where)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const ligne = { receivedAt: new Date(), ...data } as unknown as LigneSoumission;
      this.soumissions.push(ligne);
      return ligne;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneSoumission>;
    }) => {
      const ligne = this.soumissions.find((s) => s.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
  };

  readonly submissionRevision = {
    create: async ({ data }: { data: Omit<LigneRevision, 'id' | 'changedAt'> }) => {
      const ligne: LigneRevision = { id: randomUUID(), changedAt: new Date(), ...data };
      this.revisionsEnregistrees.push(ligne);
      return ligne;
    },
    findMany: async ({ where }: { where: { submissionId: string } }) =>
      this.revisionsEnregistrees
        .filter((r) => r.submissionId === where.submissionId)
        .sort((a, b) => a.revision - b.revision),
  };

  enServicePrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
