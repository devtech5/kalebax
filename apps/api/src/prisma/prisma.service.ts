import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Accès à PostgreSQL.
 *
 * Depuis Prisma 7, la connexion passe par un adaptateur explicite plutôt que
 * par une URL lue dans le schéma : le schéma décrit la forme des données, la
 * configuration vit dans l'environnement.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly journal = new Logger(PrismaService.name);

  constructor(connectionString: string = process.env['DATABASE_URL'] ?? '') {
    if (connectionString === '') {
      throw new Error(
        "DATABASE_URL n'est pas définie. Copiez apps/api/.env.example en .env et renseignez la connexion.",
      );
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.journal.log('Connexion à PostgreSQL établie.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
