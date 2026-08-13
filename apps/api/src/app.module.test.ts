import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { LECTEUR_APPARTENANCES } from './auth/appartenances.port.js';
import { AuthGuard } from './auth/auth.guard.js';
import { JetonsService } from './auth/jetons.service.js';
import { SecretsService } from './auth/secrets.service.js';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * Le câblage de l'injection de dépendances ne se voit pas à la compilation :
 * une dépendance manquante ne se manifeste qu'au démarrage, en production.
 */
async function assembler() {
  return Test.createTestingModule({ imports: [AppModule] })
    // La base n'est pas nécessaire pour vérifier le câblage, et l'exiger
    // rendrait ce test dépendant d'un conteneur qui tourne.
    .overrideProvider(PrismaService)
    .useValue({ membership: { findUnique: async () => null } })
    .compile();
}

describe('assemblage de l\'application', () => {
  it('résout toutes les dépendances', async () => {
    const module = await assembler();
    expect(module.get(JetonsService)).toBeInstanceOf(JetonsService);
    expect(module.get(SecretsService)).toBeInstanceOf(SecretsService);
    expect(module.get(LECTEUR_APPARTENANCES)).toBeDefined();
  });

  it('installe le garde globalement', async () => {
    // Une route est protégée par défaut : l'ouvrir au public doit être un acte
    // explicite. L'inverse laisse toujours passer celle qu'on a oublié
    // d'annoter. Les gardes globaux ne sont pas résolvables par leur token, on
    // vérifie donc la déclaration du module.
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    const global = providers.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === APP_GUARD &&
        (p as { useExisting?: unknown }).useExisting === AuthGuard,
    );
    expect(global).toBe(true);
  });

  it('injecte le lecteur d\'appartenances dans le garde', async () => {
    const module = await assembler();
    const garde = module.get(AuthGuard);
    expect(garde).toBeInstanceOf(AuthGuard);
    // Le garde refuse sans en-tête : preuve qu'il est fonctionnel, donc que
    // ses trois dépendances ont bien été fournies.
    await expect(
      garde.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
        getHandler: () => function route() {},
        getClass: () => class Controleur {},
      } as never),
    ).rejects.toThrow();
  });
});

describe('service Prisma', () => {
  it('refuse de démarrer sans URL de connexion', () => {
    // Un démarrage silencieux sans base produirait des erreurs incompréhensibles
    // à la première requête.
    expect(() => new PrismaService('')).toThrow(/DATABASE_URL/);
  });
});
