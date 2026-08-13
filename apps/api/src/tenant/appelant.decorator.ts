import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { CLE_CONTEXTE, type ContexteAppelant } from './contexte.js';

/**
 * Injecte l'identité de l'appelant dans une méthode de contrôleur.
 *
 * C'est le seul chemin par lequel un contrôleur apprend pour quelle
 * organisation il travaille : il n'y a pas d'autre source, et surtout pas le
 * corps de la requête.
 */
export const Appelant = createParamDecorator(
  (_donnees: unknown, contexteExecution: ExecutionContext): ContexteAppelant => {
    const requete = contexteExecution
      .switchToHttp()
      .getRequest<{ [CLE_CONTEXTE]?: ContexteAppelant }>();

    const contexte = requete[CLE_CONTEXTE];
    if (contexte === undefined) {
      // Le garde n'a pas tourné : la route est annotée publique mais réclame
      // une identité. C'est une erreur de programmation, pas d'appel.
      throw new UnauthorizedException('Authentification requise.');
    }
    return contexte;
  },
);
