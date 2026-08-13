import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// Node lit les fichiers d'environnement nativement depuis la 20.12.
if (existsSync('.env')) process.loadEnvFile('.env');

async function demarrer(): Promise<void> {
  verifierConfiguration();

  const application = await NestFactory.create(AppModule, {
    // Les corps de requête d'une synchronisation portent des lots de
    // soumissions : la limite par défaut d'Express est trop basse.
    bodyParser: true,
  });

  application.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Une propriété inconnue est retirée sans bruit plutôt que refusée : un
      // agent dont l'application est en retard d'une version doit continuer à
      // pouvoir envoyer ses données.
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const port = Number(process.env['PORT'] ?? 3000);
  await application.listen(port);
  new Logger('Kalebax').log(`API à l'écoute sur le port ${port}.`);
}

/**
 * Une clé de signature générée au démarrage invaliderait toutes les sessions à
 * chaque redéploiement et différerait d'une instance à l'autre derrière un
 * répartiteur de charge. Tolérable en développement, jamais en production.
 */
function verifierConfiguration(): void {
  const production = process.env['NODE_ENV'] === 'production';
  if (!production) return;

  const manquantes = ['DATABASE_URL', 'JWT_PRIVATE_KEY'].filter(
    (nom) => (process.env[nom] ?? '') === '',
  );
  if (manquantes.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes en production : ${manquantes.join(', ')}.`,
    );
  }
}

await demarrer();
