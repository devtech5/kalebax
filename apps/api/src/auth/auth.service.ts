import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ENVOYEUR_CODE, type CanalEnvoi, type EnvoyeurCode } from './envoi-code.port.js';
import { JetonsService, type RoleJeton } from './jetons.service.js';
import { SecretsService } from './secrets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Limites de demande de code — docs/authentification.md §3. */
export const LIMITES_OTP = {
  parHeure: 3,
  parJour: 10,
  tentativesParDefi: 3,
  dureeValiditeMinutes: 5,
} as const;

export const DUREE_RAFRAICHISSEMENT_JOURS = 60;

export interface Appartenance {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: RoleJeton;
}

export interface Jetons {
  readonly acces: string;
  readonly rafraichissement: string;
  readonly expireDans: number;
  readonly organizationId: string;
  readonly role: RoleJeton;
  /** Durée de session locale accordée par l'organisation, en jours. */
  readonly toleranceHorsLigneJours: number;
}

export type ResultatConnexion =
  | { readonly type: 'jetons'; readonly jetons: Jetons }
  /** L'utilisateur appartient à plusieurs organisations : aucun jeton tant qu'il n'a pas choisi. */
  | { readonly type: 'choix'; readonly appartenances: readonly Appartenance[] };

@Injectable()
export class AuthService {
  private readonly journal = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jetons: JetonsService,
    private readonly secrets: SecretsService,
    @Inject(ENVOYEUR_CODE) private readonly envoyeur: EnvoyeurCode,
  ) {}

  /* ------------------------------------------------------ mot de passe */

  async connexionMotDePasse(
    email: string,
    motDePasse: string,
    organizationId?: string,
  ): Promise<ResultatConnexion> {
    const utilisateur = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, passwordHash: true, status: true },
    });

    // Compte inconnu : on consomme le même temps qu'une vérification réelle.
    // Un message identique ne suffit pas, la latence parle aussi.
    if (utilisateur?.passwordHash == null) {
      await this.secrets.verifierLeurre(motDePasse);
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    const correct = await this.secrets.verifier(utilisateur.passwordHash, motDePasse);
    if (!correct || utilisateur.status !== 'active') {
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    return this.ouvrirSession(utilisateur.id, organizationId);
  }

  /* -------------------------------------------------------------- OTP */

  /**
   * Demande d'un code.
   *
   * La réponse est **toujours la même**, que le numéro corresponde ou non à un
   * compte : sinon l'API devient un annuaire des agents d'une organisation.
   */
  async demanderCode(telephone: string, canal: CanalEnvoi = 'whatsapp'): Promise<void> {
    const numero = telephone.trim();
    await this.verifierDebitOtp(numero);

    const utilisateur = await this.prisma.user.findUnique({
      where: { phone: numero },
      select: { id: true, status: true },
    });

    // On enregistre le défi même pour un numéro inconnu : la table de débit
    // doit se remplir de la même façon, sans quoi les limites elles-mêmes
    // révèlent quels numéros existent.
    const code = this.secrets.genererCodeOtp();
    await this.prisma.otpChallenge.create({
      data: {
        phone: numero,
        codeHash: await this.secrets.hacher(code),
        channel: canal,
        expiresAt: new Date(Date.now() + LIMITES_OTP.dureeValiditeMinutes * 60_000),
      },
    });

    if (utilisateur !== null && utilisateur.status === 'active') {
      await this.envoyeur.envoyer(numero, code, canal);
    }
  }

  private async verifierDebitOtp(telephone: string): Promise<void> {
    const maintenant = Date.now();
    const [derniereHeure, dernierJour] = await Promise.all([
      this.prisma.otpChallenge.count({
        where: { phone: telephone, createdAt: { gte: new Date(maintenant - 3_600_000) } },
      }),
      this.prisma.otpChallenge.count({
        where: { phone: telephone, createdAt: { gte: new Date(maintenant - 86_400_000) } },
      }),
    ]);

    // Un SMS coûte de l'argent : une boucle de demandes est autant un vol
    // qu'un déni de service.
    if (derniereHeure >= LIMITES_OTP.parHeure || dernierJour >= LIMITES_OTP.parJour) {
      throw new HttpException(
        'Trop de demandes de code. Réessayez dans une heure.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async verifierCode(
    telephone: string,
    code: string,
    organizationId?: string,
  ): Promise<ResultatConnexion> {
    const numero = telephone.trim();
    const defi = await this.prisma.otpChallenge.findFirst({
      where: { phone: numero, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (defi === null) {
      throw new UnauthorizedException('Code invalide ou expiré.');
    }

    if (defi.attempts >= LIMITES_OTP.tentativesParDefi) {
      // Le défi est brûlé : il ne sert à rien de laisser essayer davantage.
      await this.prisma.otpChallenge.update({
        where: { id: defi.id },
        data: { consumedAt: new Date() },
      });
      throw new UnauthorizedException('Code invalide ou expiré.');
    }

    const correct = await this.secrets.verifier(defi.codeHash, code.trim());
    if (!correct) {
      await this.prisma.otpChallenge.update({
        where: { id: defi.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Code invalide ou expiré.');
    }

    await this.prisma.otpChallenge.update({
      where: { id: defi.id },
      data: { consumedAt: new Date() },
    });

    const utilisateur = await this.prisma.user.findUnique({
      where: { phone: numero },
      select: { id: true, status: true },
    });
    if (utilisateur === null || utilisateur.status !== 'active') {
      throw new UnauthorizedException('Code invalide ou expiré.');
    }

    return this.ouvrirSession(utilisateur.id, organizationId);
  }

  /* ---------------------------------------------------------- sessions */

  private async ouvrirSession(
    userId: string,
    organizationId?: string,
  ): Promise<ResultatConnexion> {
    const appartenances = await this.prisma.membership.findMany({
      where: { userId, status: 'active' },
      select: {
        organizationId: true,
        role: true,
        organization: { select: { name: true } },
      },
    });

    if (appartenances.length === 0) {
      throw new UnauthorizedException("Aucune organisation n'est associée à ce compte.");
    }

    const retenue =
      organizationId === undefined
        ? appartenances.length === 1
          ? appartenances[0]
          : undefined
        : appartenances.find((a) => a.organizationId === organizationId);

    if (retenue === undefined) {
      // Plusieurs organisations, ou une organisation demandée à laquelle
      // l'utilisateur n'appartient pas : dans les deux cas on renvoie la liste
      // réelle, sans distinguer les cas.
      return {
        type: 'choix',
        appartenances: appartenances.map((a) => ({
          organizationId: a.organizationId,
          organizationName: a.organization.name,
          role: a.role as RoleJeton,
        })),
      };
    }

    return {
      type: 'jetons',
      jetons: await this.emettre(userId, retenue.organizationId, retenue.role as RoleJeton),
    };
  }

  private async emettre(
    userId: string,
    organizationId: string,
    role: RoleJeton,
  ): Promise<Jetons> {
    const organisation = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { offlineGraceDays: true },
    });

    const { jeton, empreinte } = this.jetons.genererRafraichissement();
    const session = await this.prisma.refreshToken.create({
      data: {
        userId,
        organizationId,
        tokenHash: empreinte,
        expiresAt: new Date(Date.now() + DUREE_RAFRAICHISSEMENT_JOURS * 86_400_000),
      },
      select: { id: true },
    });

    const acces = await this.jetons.signerAcces({
      sub: userId,
      org: organizationId,
      role,
      sid: session.id,
    });

    return {
      acces,
      rafraichissement: jeton,
      expireDans: 900,
      organizationId,
      role,
      toleranceHorsLigneJours: organisation?.offlineGraceDays ?? 7,
    };
  }

  /**
   * Rotation du jeton de rafraîchissement.
   *
   * Le jeton présenté est révoqué et remplacé. Présenter un jeton **déjà
   * remplacé** signifie qu'il a été copié — l'appareil légitime, lui, a reçu le
   * suivant : toute la chaîne de l'utilisateur est alors révoquée.
   */
  async rafraichir(jetonPresente: string): Promise<Jetons> {
    const empreinte = this.jetons.empreinte(jetonPresente);
    const existant = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: empreinte },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
      },
    });

    if (existant === null) {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    const reutilise = existant.revokedAt !== null || existant.replacedById !== null;
    if (reutilise) {
      await this.revoquerToutesLesSessions(existant.userId, existant.organizationId);
      this.journal.warn(
        `Réutilisation d'un jeton de rafraîchissement déjà remplacé : sessions révoquées pour ${existant.userId}.`,
      );
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    if (existant.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    const appartenance = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: existant.userId,
          organizationId: existant.organizationId,
        },
      },
      select: { role: true, status: true },
    });

    if (appartenance === null) {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    const jetons = await this.emettre(
      existant.userId,
      existant.organizationId,
      appartenance.role as RoleJeton,
    );

    const nouvelle = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.jetons.empreinte(jetons.rafraichissement) },
      select: { id: true },
    });

    await this.prisma.refreshToken.update({
      where: { id: existant.id },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date(),
        replacedById: nouvelle?.id ?? null,
      },
    });

    return jetons;
  }

  async revoquerSession(sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revoquerToutesLesSessions(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
