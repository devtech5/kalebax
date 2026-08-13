import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DatasetsService, LIMITES_DATASET } from './datasets.service.js';
import { ZodPipe } from '../commun/zod.pipe.js';
import { Appelant } from '../tenant/appelant.decorator.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const schemaCreation = z.object({
  name: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
});

/** Attributs plats : le filtrage en cascade ne parcourt pas de structure imbriquée. */
const attribut = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const schemaImport = z.object({
  entrees: z
    .array(
      z.object({
        value: z.string().min(1).max(LIMITES_DATASET.longueurValeur),
        label: z.string().min(1).max(500),
        attributes: z.record(z.string(), attribut).optional(),
      }),
    )
    .max(LIMITES_DATASET.entreesParJeu),
});

@Controller('datasets')
export class DatasetsController {
  constructor(private readonly datasets: DatasetsService) {}

  @Post()
  creer(
    @Appelant() appelant: ContexteAppelant,
    @Body(new ZodPipe(schemaCreation)) corps: z.infer<typeof schemaCreation>,
  ) {
    return this.datasets.creer(appelant, corps);
  }

  @Get()
  lister(@Appelant() appelant: ContexteAppelant) {
    return this.datasets.lister(appelant);
  }

  /** Remplace le contenu. La version n'augmente que si quelque chose change. */
  @Post(':id/import')
  importer(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') datasetId: string,
    @Body(new ZodPipe(schemaImport)) corps: z.infer<typeof schemaImport>,
  ) {
    return this.datasets.importer(appelant, datasetId, corps.entrees);
  }

  @Get(':id/entries')
  listerEntrees(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') datasetId: string,
    @Query('limite') limite?: string,
    @Query('decalage') decalage?: string,
  ) {
    return this.datasets.listerEntrees(
      appelant,
      datasetId,
      limite === undefined ? undefined : Number(limite),
      decalage === undefined ? undefined : Number(decalage),
    );
  }
}
