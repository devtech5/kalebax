import { randomUUID } from 'node:crypto';
import { BasePrismaSoumissions } from '../soumissions/prisma-memoire-soumissions.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface LigneAttachment {
  id: string;
  organizationId: string;
  submissionId: string;
  questionName: string;
  kind: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  uploadedAt: Date | null;
}

interface LigneProjet {
  id: string;
  organizationId: string;
}

/**
 * Base en mémoire pour les tests de synchronisation.
 *
 * Étend celle des soumissions : le lot montant passe par le même service, et
 * dupliquer la base ferait diverger les deux jeux de tests.
 */
export class BasePrismaSync extends BasePrismaSoumissions {
  readonly attachments: LigneAttachment[] = [];
  readonly projets: LigneProjet[] = [];

  readonly attachment = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.attachments.find((a) => a.id === where.id) ?? null,
    create: async ({ data }: { data: Omit<LigneAttachment, 'uploadedAt'> }) => {
      const ligne: LigneAttachment = { uploadedAt: null, ...data };
      this.attachments.push(ligne);
      return ligne;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<LigneAttachment>;
    }) => {
      const ligne = this.attachments.find((a) => a.id === where.id);
      if (ligne !== undefined) Object.assign(ligne, data);
      return ligne ?? null;
    },
  };

  readonly project = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.projets.find((p) => p.id === where.id) ?? null,
  };

  /** Formulaires, pour le paquet descendant. */
  readonly formVersionsCompletes: {
    id: string;
    organizationId: string;
    formId: string;
    versionNumber: number;
    status: string;
    schema: unknown;
    projectId: string;
    formName: string;
  }[] = [];

  override readonly formVersion = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const ligne = this.versions.find((v) => v.id === where.id);
      if (ligne === undefined) return null;
      return { ...ligne, form: { projectId: ligne.projectId } };
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const statuts = (where['status'] as { in?: string[] } | undefined)?.in;
      return this.formVersionsCompletes
        .filter((v) => v.organizationId === where['organizationId'])
        .filter((v) => statuts === undefined || statuts.includes(v.status))
        .map((v) => ({
          id: v.id,
          formId: v.formId,
          versionNumber: v.versionNumber,
          status: v.status,
          schema: v.schema,
          form: { projectId: v.projectId, name: v.formName },
        }));
    },
  };

  ajouterProjet(organizationId: string): string {
    const id = randomUUID();
    this.projets.push({ id, organizationId });
    return id;
  }

  override enServicePrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
