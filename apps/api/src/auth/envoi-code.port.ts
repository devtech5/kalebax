import { Injectable, Logger } from '@nestjs/common';

export type CanalEnvoi = 'sms' | 'whatsapp';

/**
 * Envoi du code à usage unique.
 *
 * WhatsApp d'abord, SMS en repli : le message WhatsApp ne coûte rien et arrive
 * même sur un réseau dégradé, le SMS reste le seul canal qui fonctionne sans
 * données mobiles.
 */
export interface EnvoyeurCode {
  envoyer(telephone: string, code: string, canal: CanalEnvoi): Promise<void>;
}

export const ENVOYEUR_CODE = Symbol('EnvoyeurCode');

/**
 * Implémentation de développement : journalise au lieu d'envoyer.
 *
 * Elle refuse de fonctionner en production — envoyer un code dans les journaux
 * d'un serveur revient à le publier.
 */
@Injectable()
export class EnvoyeurCodeJournal implements EnvoyeurCode {
  private readonly journal = new Logger('EnvoiCode');

  async envoyer(telephone: string, code: string, canal: CanalEnvoi): Promise<void> {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        "Aucun fournisseur d'envoi de code n'est configuré : le code serait écrit dans les journaux.",
      );
    }
    this.journal.warn(`[${canal}] ${telephone} → ${code}`);
  }
}
