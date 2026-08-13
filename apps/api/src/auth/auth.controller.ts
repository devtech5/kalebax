import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type ResultatConnexion } from './auth.service.js';
import { Publique } from './auth.guard.js';
import { ZodPipe } from '../commun/zod.pipe.js';
import { CLE_CONTEXTE, type ContexteAppelant } from '../tenant/contexte.js';

const uuid = z.uuid();

const schemaConnexion = z.object({
  email: z.email(),
  motDePasse: z.string().min(1),
  organizationId: uuid.optional(),
});

/** E.164 : le format international est le seul non ambigu entre pays. */
const telephone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Numéro attendu au format international, par exemple +2250700000000.');

const schemaDemandeCode = z.object({
  telephone,
  canal: z.enum(['whatsapp', 'sms']).default('whatsapp'),
});

const schemaVerificationCode = z.object({
  telephone,
  code: z.string().regex(/^\d{6}$/),
  organizationId: uuid.optional(),
});

const schemaRafraichissement = z.object({
  rafraichissement: z.string().min(1),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Publique()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async connexion(
    @Body(new ZodPipe(schemaConnexion)) corps: z.infer<typeof schemaConnexion>,
  ): Promise<ResultatConnexion> {
    return this.auth.connexionMotDePasse(corps.email, corps.motDePasse, corps.organizationId);
  }

  /**
   * Réponse toujours identique, qu'un compte existe ou non derrière ce numéro :
   * sinon l'API devient un annuaire des agents d'une organisation.
   */
  @Publique()
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async demanderCode(
    @Body(new ZodPipe(schemaDemandeCode)) corps: z.infer<typeof schemaDemandeCode>,
  ): Promise<{ message: string }> {
    await this.auth.demanderCode(corps.telephone, corps.canal);
    return {
      message: 'Si ce numéro correspond à un compte, un code vient de lui être envoyé.',
    };
  }

  @Publique()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifierCode(
    @Body(new ZodPipe(schemaVerificationCode)) corps: z.infer<typeof schemaVerificationCode>,
  ): Promise<ResultatConnexion> {
    return this.auth.verifierCode(corps.telephone, corps.code, corps.organizationId);
  }

  /**
   * Route publique : c'est le jeton de rafraîchissement présenté qui fait foi,
   * pas un jeton d'accès — lequel a précisément expiré si l'on en est là.
   */
  @Publique()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async rafraichir(
    @Body(new ZodPipe(schemaRafraichissement)) corps: z.infer<typeof schemaRafraichissement>,
  ) {
    return this.auth.rafraichir(corps.rafraichissement);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deconnexion(@Req() requete: { [CLE_CONTEXTE]?: ContexteAppelant }): Promise<void> {
    const contexte = requete[CLE_CONTEXTE];
    if (contexte !== undefined) {
      await this.auth.revoquerSession(contexte.sessionId);
    }
  }

  @Get('moi')
  identite(@Req() requete: { [CLE_CONTEXTE]?: ContexteAppelant }): ContexteAppelant | null {
    return requete[CLE_CONTEXTE] ?? null;
  }
}
