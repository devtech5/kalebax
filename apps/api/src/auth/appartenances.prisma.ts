import { Injectable } from '@nestjs/common';
import type { EtatAppartenance, LecteurAppartenances } from './appartenances.port.js';
import type { RoleJeton } from './jetons.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Lecture de l'appartenance en base, pour le garde.
 *
 * Une seule requête, sur un index `(userId, organizationId)` unique : elle est
 * exécutée à chaque appel authentifié, elle doit rester triviale.
 */
@Injectable()
export class AppartenancesPrisma implements LecteurAppartenances {
  constructor(private readonly prisma: PrismaService) {}

  async lire(userId: string, organizationId: string): Promise<EtatAppartenance | null> {
    const appartenance = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: {
        role: true,
        status: true,
        organization: { select: { status: true } },
        user: { select: { status: true } },
      },
    });

    if (appartenance === null) return null;

    return {
      role: appartenance.role as RoleJeton,
      revoque: appartenance.status === 'revoked',
      statutOrganisation: appartenance.organization.status,
      utilisateurActif: appartenance.user.status === 'active',
    };
  }
}
