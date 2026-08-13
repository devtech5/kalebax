import { randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Hachage des mots de passe et des codes à usage unique — Argon2id.
 *
 * Les deux passent par la même fonction : un code à six chiffres est un secret
 * au même titre qu'un mot de passe, et le stocker en clair rendrait une fuite
 * de la table équivalente à un accès aux comptes.
 */

/**
 * Paramètres Argon2id.
 *
 * 19 Mio et 2 passes correspondent au profil recommandé par l'OWASP. Ils
 * s'exécutent sur un serveur, pas sur le téléphone de l'agent : la contrainte
 * de matériel modeste ne s'applique pas ici.
 */
const PARAMETRES = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Condensat d'un mot de passe fictif, utilisé quand le compte est inconnu.
 *
 * Sans lui, une réponse immédiate pour un compte inexistant et une réponse
 * lente pour un compte existant révèlent lesquelles des adresses essayées sont
 * réelles. Le message identique ne suffit pas : la latence parle aussi.
 */
let condensatLeurre: string | null = null;

@Injectable()
export class SecretsService {
  async hacher(secret: string): Promise<string> {
    return hash(secret, PARAMETRES);
  }

  async verifier(condensat: string, secret: string): Promise<boolean> {
    try {
      return await verify(condensat, secret, PARAMETRES);
    } catch {
      // Un condensat corrompu ou d'un autre format ne doit pas faire tomber la
      // requête : c'est un échec d'authentification, rien de plus.
      return false;
    }
  }

  /**
   * Consomme le même temps qu'une vérification réelle, sans compte à vérifier.
   * À appeler sur chaque tentative visant un identifiant inconnu.
   */
  async verifierLeurre(secret: string): Promise<false> {
    condensatLeurre ??= await this.hacher('mot de passe qui n existe pas');
    await this.verifier(condensatLeurre, secret);
    return false;
  }

  /**
   * Code à usage unique de six chiffres, tiré d'une source cryptographique.
   *
   * `Math.random()` serait prévisible à partir de quelques observations, ce qui
   * suffirait à prendre la main sur le compte d'un agent.
   */
  genererCodeOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** Comparaison à temps constant, pour les valeurs déjà en clair des deux côtés. */
  comparerConstant(a: string, b: string): boolean {
    const tampon = Buffer.from(a);
    const autre = Buffer.from(b);
    if (tampon.length !== autre.length) return false;
    return timingSafeEqual(tampon, autre);
  }
}
