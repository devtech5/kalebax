import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SoumissionsService } from './soumissions.service.js';
import { ZodPipe } from '../commun/zod.pipe.js';
import { Appelant } from '../tenant/appelant.decorator.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const schemaSoumission = z.object({
  // Généré côté client, hors ligne : c'est lui qui rend la réception
  // idempotente.
  id: z.uuid(),
  formVersionId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  deviceId: z.string().max(200).optional(),
  appVersion: z.string().max(50).optional(),
  startLatitude: z.number().min(-90).max(90).optional(),
  startLongitude: z.number().min(-180).max(180).optional(),
  startAccuracy: z.number().nonnegative().optional(),
  startGeopointStatus: z
    .enum(['captured', 'denied', 'unavailable', 'timeout', 'skipped'])
    .optional(),
});

const schemaCorrection = z.object({
  data: z.record(z.string(), z.unknown()),
  motif: z.string().max(2000).optional(),
});

@Controller('submissions')
export class SoumissionsController {
  constructor(private readonly soumissions: SoumissionsService) {}

  /**
   * Réception d'une soumission.
   *
   * Répond 200 et non 201 : la requête est idempotente, et rejouer une
   * synchronisation interrompue doit être indiscernable du premier envoi.
   */
  @Post()
  recevoir(
    @Appelant() appelant: ContexteAppelant,
    @Body(new ZodPipe(schemaSoumission)) corps: z.infer<typeof schemaSoumission>,
  ) {
    return this.soumissions.recevoir(appelant, corps);
  }

  @Get()
  lister(
    @Appelant() appelant: ContexteAppelant,
    @Query('projectId') projectId?: string,
  ) {
    return this.soumissions.lister(appelant, projectId);
  }

  /** Crée une révision horodatée et attribuée ; n'écrase jamais l'état d'origine. */
  @Patch(':id')
  corriger(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') id: string,
    @Body(new ZodPipe(schemaCorrection)) corps: z.infer<typeof schemaCorrection>,
  ) {
    return this.soumissions.corriger(appelant, id, corps.data, corps.motif);
  }

  @Get(':id/revisions')
  revisions(@Appelant() appelant: ContexteAppelant, @Param('id') id: string) {
    return this.soumissions.revisions(appelant, id);
  }
}
