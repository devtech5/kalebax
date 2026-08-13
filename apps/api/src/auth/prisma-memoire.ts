import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Base en mémoire, pour les tests d'authentification.
 *
 * Les règles portées par `AuthService` — rotation des jetons, débit des codes,
 * énumération de comptes — doivent être testables sans PostgreSQL, sinon elles
 * ne seront testées ni assez souvent ni assez tôt. Elle n'implémente que ce que
 * le service appelle réellement.
 */

export interface LigneUtilisateur {
  id: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  status: string;
}

export interface LigneAppartenance {
  userId: string;
  organizationId: string;
  role: string;
  status: string;
}

export interface LigneOrganisation {
  id: string;
  name: string;
  offlineGraceDays: number;
  status: string;
}

export interface LigneJeton {
  id: string;
  userId: string;
  organizationId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  lastUsedAt: Date | null;
}

export interface LigneDefi {
  id: string;
  phone: string;
  codeHash: string;
  channel: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export class PrismaMemoire {
  readonly utilisateurs: LigneUtilisateur[] = [];
  readonly appartenances: LigneAppartenance[] = [];
  readonly organisations: LigneOrganisation[] = [];
  readonly jetons: LigneJeton[] = [];
  readonly defis: LigneDefi[] = [];

  readonly user = {
    findUnique: async ({ where }: { where: { email?: string; phone?: string } }) => {
      const trouve = this.utilisateurs.find(
        (u) =>
          (where.email !== undefined && u.email === where.email) ||
          (where.phone !== undefined && u.phone === where.phone),
      );
      return trouve ?? null;
    },
  };

  readonly organization = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.organisations.find((o) => o.id === where.id) ?? null,
  };

  readonly membership = {
    findUnique: async ({
      where,
    }: {
      where: { userId_organizationId: { userId: string; organizationId: string } };
    }) => {
      const { userId, organizationId } = where.userId_organizationId;
      return (
        this.appartenances.find(
          (a) => a.userId === userId && a.organizationId === organizationId,
        ) ?? null
      );
    },
    findMany: async ({ where }: { where: { userId: string; status?: string } }) =>
      this.appartenances
        .filter(
          (a) =>
            a.userId === where.userId &&
            (where.status === undefined || a.status === where.status),
        )
        .map((a) => ({
          ...a,
          organization: {
            name: this.organisations.find((o) => o.id === a.organizationId)?.name ?? '',
          },
        })),
  };

  readonly refreshToken = {
    create: async ({ data }: { data: Omit<LigneJeton, 'id' | 'revokedAt' | 'replacedById' | 'lastUsedAt'> }) => {
      const ligne: LigneJeton = {
        id: randomUUID(),
        revokedAt: null,
        replacedById: null,
        lastUsedAt: null,
        ...data,
      };
      this.jetons.push(ligne);
      return ligne;
    },
    findUnique: async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
      this.jetons.find(
        (j) =>
          (where.tokenHash !== undefined && j.tokenHash === where.tokenHash) ||
          (where.id !== undefined && j.id === where.id),
      ) ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneJeton>;
    }) => {
      const ligne = this.jetons.find((j) => j.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { userId?: string; organizationId?: string; id?: string; revokedAt?: null };
      data: Partial<LigneJeton>;
    }) => {
      let touchees = 0;
      for (const ligne of this.jetons) {
        if (where.userId !== undefined && ligne.userId !== where.userId) continue;
        if (where.organizationId !== undefined && ligne.organizationId !== where.organizationId)
          continue;
        if (where.id !== undefined && ligne.id !== where.id) continue;
        if (where.revokedAt === null && ligne.revokedAt !== null) continue;
        Object.assign(ligne, data);
        touchees += 1;
      }
      return { count: touchees };
    },
  };

  readonly otpChallenge = {
    create: async ({
      data,
    }: {
      data: Omit<LigneDefi, 'id' | 'attempts' | 'consumedAt' | 'createdAt'>;
    }) => {
      const ligne: LigneDefi = {
        id: randomUUID(),
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };
      this.defis.push(ligne);
      return ligne;
    },
    count: async ({ where }: { where: { phone: string; createdAt: { gte: Date } } }) =>
      this.defis.filter(
        (d) => d.phone === where.phone && d.createdAt >= where.createdAt.gte,
      ).length,
    findFirst: async ({ where }: { where: { phone: string } }) =>
      [...this.defis]
        .filter(
          (d) => d.phone === where.phone && d.consumedAt === null && d.expiresAt > new Date(),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { attempts?: { increment: number }; consumedAt?: Date };
    }) => {
      const ligne = this.defis.find((d) => d.id === where.id);
      if (ligne === undefined) return null;
      if (data.attempts !== undefined) ligne.attempts += data.attempts.increment;
      if (data.consumedAt !== undefined) ligne.consumedAt = data.consumedAt;
      return ligne;
    },
  };

  /** Vue typée comme le vrai service, pour l'injecter là où il est attendu. */
  enServicePrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
