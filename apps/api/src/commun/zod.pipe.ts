import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validation des entrées par Zod — le même outil que celui qui valide les
 * documents de formulaire dans packages/shared.
 *
 * Les messages remontent tels quels : ils sont destinés à un développeur qui
 * intègre l'API, pas à un enquêté.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(valeur: unknown): T {
    const resultat = this.schema.safeParse(valeur);
    if (!resultat.success) {
      throw new BadRequestException({
        message: 'Requête invalide.',
        details: resultat.error.issues.map((probleme) => ({
          champ: probleme.path.join('.'),
          message: probleme.message,
        })),
      });
    }
    return resultat.data;
  }
}
