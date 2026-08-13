import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Node charge les fichiers d'environnement nativement depuis la 20.12 : pas de
// dépendance à dotenv pour lire un fichier de quinze lignes.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Configuration de l'outil Prisma — migrations et génération du client.
 *
 * Depuis Prisma 7, l'URL de connexion ne vit plus dans le schéma : celui-ci
 * décrit la forme des données et rien d'autre, sans dépendance à
 * l'environnement ni secret à ne pas committer par mégarde.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
