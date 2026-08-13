import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { SyncService } from './sync.service.js';
import { ZodPipe } from '../commun/zod.pipe.js';
import { Appelant } from '../tenant/appelant.decorator.js';
import type { ContexteAppelant } from '../tenant/contexte.js';

const schemaSoumission = z.object({
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

/** Bornes du lot — docs/synchronisation.md §5.1, appliquées aussi côté serveur. */
const schemaLot = z.object({
  soumissions: z.array(schemaSoumission).min(1).max(25),
});

const schemaAnnonceMedia = z.object({
  submissionId: z.uuid(),
  questionName: z.string().min(1).max(200),
  kind: z.enum(['photo', 'audio', 'video', 'signature', 'file']),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.int().positive().max(100 * 1024 * 1024),
  /** SHA-256 en hexadécimal. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.iso.datetime().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const schemaEtat = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

/**
 * Lit `points_vente:12,localites:4`.
 *
 * Une entrée mal formée est ignorée plutôt que rejetée : un appareil dont le
 * paramètre est abîmé recevra l'intégral, ce qui coûte des octets mais le
 * laisse travailler. Refuser le bundle l'empêcherait de partir en mission.
 */
function lireVersionsJeux(brut?: string): Record<string, number> {
  if (brut === undefined || brut === '') return {};
  const versions: Record<string, number> = {};
  for (const morceau of brut.split(',')) {
    const [nom, version] = morceau.split(':');
    const numero = Number(version);
    if (nom === undefined || nom === '' || !Number.isInteger(numero) || numero < 0) continue;
    versions[nom] = numero;
  }
  return versions;
}

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Répond 200 avec un résultat par élément.
   *
   * Jamais 207 ni un code d'erreur : un lot partiellement traité est un succès
   * partiel, et c'est le corps qui porte le détail.
   */
  @Post('submissions')
  @HttpCode(HttpStatus.OK)
  recevoirLot(
    @Appelant() appelant: ContexteAppelant,
    @Body(new ZodPipe(schemaLot)) corps: z.infer<typeof schemaLot>,
  ) {
    return this.sync.recevoirLot(appelant, corps.soumissions).then((resultats) => ({
      resultats,
    }));
  }

  @Post('attachments/:id/init')
  @HttpCode(HttpStatus.OK)
  initierMedia(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') mediaId: string,
    @Body(new ZodPipe(schemaAnnonceMedia)) corps: z.infer<typeof schemaAnnonceMedia>,
  ) {
    return this.sync.initierMedia(appelant, mediaId, corps);
  }

  /**
   * Reçoit un morceau à un offset donné.
   *
   * Le corps est binaire : l'encoder en base64 gonflerait de 33 % un transfert
   * déjà payé au mégaoctet par l'agent.
   */
  @Put('attachments/:id/chunk')
  @HttpCode(HttpStatus.OK)
  async recevoirMorceau(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') mediaId: string,
    @Headers('x-offset') offsetBrut: string,
    @Req() requete: { body?: unknown },
  ) {
    const offset = Number(offsetBrut);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("En-tête X-Offset manquant ou invalide.");
    }
    const morceau = Buffer.isBuffer(requete.body)
      ? new Uint8Array(requete.body)
      : new Uint8Array(0);

    return this.sync.recevoirMorceau(appelant, mediaId, offset, morceau);
  }

  @Post('attachments/:id/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async completerMedia(
    @Appelant() appelant: ContexteAppelant,
    @Param('id') mediaId: string,
  ): Promise<void> {
    await this.sync.completerMedia(appelant, mediaId);
  }

  /**
   * Différentiel : l'appareil annonce ce qu'il détient, le serveur complète.
   *
   * `datasets` se lit `points_vente:12,localites:4` — le format tient dans une
   * URL et se relit à l'œil dans un journal de serveur, ce qui compte quand on
   * diagnostique une synchronisation depuis un bureau régional.
   */
  @Get('bundle')
  paquet(
    @Appelant() appelant: ContexteAppelant,
    @Query('projectId') projectId: string,
    @Query('versions') versions?: string,
    @Query('datasets') datasets?: string,
  ) {
    const detenues = versions === undefined || versions === '' ? [] : versions.split(',');
    return this.sync.paquet(appelant, projectId, detenues, lireVersionsJeux(datasets));
  }

  /** Diagnostic de terrain : ce que le serveur pense détenir de cet appareil. */
  @Post('etat')
  @HttpCode(HttpStatus.OK)
  etat(
    @Appelant() appelant: ContexteAppelant,
    @Body(new ZodPipe(schemaEtat)) corps: z.infer<typeof schemaEtat>,
  ) {
    return this.sync.etat(appelant, corps.ids);
  }
}
