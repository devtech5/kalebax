import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  LECTEUR_APPARTENANCES,
  type LecteurAppartenances,
} from './appartenances.port.js';
import { JetonsService } from './jetons.service.js';
import { CLE_CONTEXTE, type ContexteAppelant } from '../tenant/contexte.js';

/** Marque une route accessible sans jeton — connexion, demande de code. */
export const PUBLIQUE = 'kalebax:publique';
export const Publique = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIQUE, true);

/**
 * Première couche d'isolement multi-tenant — docs/authentification.md §5.
 *
 * Le garde ne fait qu'une chose, mais la fait pour toutes les routes : il
 * établit qui appelle et pour quelle organisation. Aucun contrôleur ne relit un
 * en-tête d'autorisation, aucun service ne reçoit d'`organizationId` en
 * paramètre venu du client.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jetons: JetonsService,
    private readonly reflector: Reflector,
    @Inject(LECTEUR_APPARTENANCES)
    private readonly appartenances: LecteurAppartenances,
  ) {}

  async canActivate(contexteExecution: ExecutionContext): Promise<boolean> {
    const publique = this.reflector.getAllAndOverride<boolean>(PUBLIQUE, [
      contexteExecution.getHandler(),
      contexteExecution.getClass(),
    ]);
    if (publique === true) return true;

    const requete = contexteExecution.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      [CLE_CONTEXTE]?: ContexteAppelant;
    }>();

    const jeton = extraireJeton(requete.headers['authorization']);
    if (jeton === null) {
      throw new UnauthorizedException('Authentification requise.');
    }

    let contenu;
    try {
      contenu = await this.jetons.verifierAcces(jeton);
    } catch {
      // Aucun détail sur la raison du refus : expiré, mal signé ou forgé, la
      // réponse est la même.
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    // Un jeton d'accès vit quinze minutes ; sans relecture de l'appartenance à
    // chaque requête, une révocation mettrait un quart d'heure à agir.
    const etat = await this.appartenances.lire(contenu.sub, contenu.org);
    if (etat === null || !etat.utilisateurActif) {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    requete[CLE_CONTEXTE] = {
      userId: contenu.sub,
      organizationId: contenu.org,
      // Le rôle vient de la base, pas du jeton : une rétrogradation prend effet
      // immédiatement, sans attendre l'expiration.
      role: etat.role,
      sessionId: contenu.sid,
      revoque: etat.revoque,
    };

    return true;
  }
}

function extraireJeton(entete: string | string[] | undefined): string | null {
  const valeur = Array.isArray(entete) ? entete[0] : entete;
  if (typeof valeur !== 'string') return null;
  const [schema, jeton] = valeur.split(' ');
  if (schema?.toLowerCase() !== 'bearer' || jeton === undefined || jeton === '') {
    return null;
  }
  return jeton;
}
