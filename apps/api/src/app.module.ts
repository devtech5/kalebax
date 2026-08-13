import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppartenancesPrisma } from './auth/appartenances.prisma.js';
import { LECTEUR_APPARTENANCES } from './auth/appartenances.port.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { ENVOYEUR_CODE, EnvoyeurCodeJournal } from './auth/envoi-code.port.js';
import { JetonsService } from './auth/jetons.service.js';
import { SecretsService } from './auth/secrets.service.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    PrismaService,
    SecretsService,
    AuthService,
    { provide: ENVOYEUR_CODE, useClass: EnvoyeurCodeJournal },
    {
      provide: JetonsService,
      useFactory: () =>
        new JetonsService({
          clePriveePem: process.env['JWT_PRIVATE_KEY'],
          dureeAccesSecondes: Number(process.env['ACCESS_TOKEN_TTL_SECONDS'] ?? 900),
        }),
    },
    { provide: LECTEUR_APPARTENANCES, useClass: AppartenancesPrisma },
    // Déclaré sous son propre token, puis réutilisé comme garde global : une
    // seule instance, et il reste injectable là où une route a besoin de le
    // solliciter explicitement.
    AuthGuard,
    // Le garde est global : une route est protégée par défaut, et son ouverture
    // au public est un acte explicite. L'inverse — protéger route par route —
    // finit toujours par laisser passer celle qu'on a oublié d'annoter.
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [PrismaService],
})
export class AppModule {}
