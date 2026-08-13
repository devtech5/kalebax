import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { FormulairesService } from './formulaires.service.js';
import { ZodPipe } from '../commun/zod.pipe.js';
import { Appelant } from '../tenant/appelant.decorator.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const schemaProjet = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Finalité déclarée du traitement de données personnelles. */
  purpose: z.string().max(2000).optional(),
});

const schemaFormulaire = z.object({
  name: z.string().min(1).max(200),
  // Le document n'est pas validé ici : un brouillon se construit par petites
  // touches. La validation a lieu à la publication.
  schema: z.unknown().optional(),
});

const schemaDocument = z.object({ schema: z.unknown() });

@Controller()
export class FormulairesController {
  constructor(private readonly formulaires: FormulairesService) {}

  @Post('projects')
  creerProjet(
    @Appelant() appelant: ContexteAppelant,
    @Body(new ZodPipe(schemaProjet)) corps: z.infer<typeof schemaProjet>,
  ) {
    return this.formulaires.creerProjet(appelant, corps);
  }

  @Get('projects')
  listerProjets(@Appelant() appelant: ContexteAppelant) {
    return this.formulaires.listerProjets(appelant);
  }

  @Post('projects/:id/forms')
  creerFormulaire(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') projectId: string,
    @Body(new ZodPipe(schemaFormulaire)) corps: z.infer<typeof schemaFormulaire>,
  ) {
    return this.formulaires.creerFormulaire(appelant, projectId, corps);
  }

  @Get('forms/:id/versions')
  listerVersions(@Appelant() appelant: ContexteAppelant, @Param('id') formId: string) {
    return this.formulaires.listerVersions(appelant, formId);
  }

  /** Refusé si la version est publiée : corriger, c'est publier une version suivante. */
  @Patch('form-versions/:id')
  modifierVersion(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') versionId: string,
    @Body(new ZodPipe(schemaDocument)) corps: z.infer<typeof schemaDocument>,
  ) {
    return this.formulaires.modifierVersion(appelant, versionId, corps.schema);
  }

  @Post('form-versions/:id/publish')
  publier(@Appelant() appelant: ContexteAppelant, @Param('id') versionId: string) {
    return this.formulaires.publierVersion(appelant, versionId);
  }

  @Post('forms/:id/versions')
  nouvelleVersion(@Appelant() appelant: ContexteAppelant, @Param('id') formId: string) {
    return this.formulaires.nouvelleVersion(appelant, formId);
  }

  /** Document que l'application agent télécharge avant de partir en mission. */
  @Get('forms/:id/current')
  documentCourant(@Appelant() appelant: ContexteAppelant, @Param('id') formId: string) {
    return this.formulaires.documentCourant(appelant, formId);
  }
}
