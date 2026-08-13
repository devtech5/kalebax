/**
 * Ce qui change d'une cible à l'autre — et c'est tout.
 *
 * Les quatre moteurs qui comptent parlent le même SQLite : même dialecte, mêmes
 * types, mêmes contraintes. Seule la façon d'exécuter diffère — synchrone sous
 * Node, à promesses dans le navigateur, par pont natif sur mobile. Le SQL des
 * requêtes de synchronisation, là où une erreur coûte des données, n'existe donc
 * qu'en un seul exemplaire.
 */
export interface PiloteSql {
  executer(sql: string, parametres?: readonly unknown[]): Promise<void>;
  interroger<T>(sql: string, parametres?: readonly unknown[]): Promise<T[]>;
  /**
   * Exécute une suite d'écritures d'un bloc.
   *
   * Le pilote est libre de l'implémenter par une transaction native ou par le
   * mécanisme de son moteur ; le contrat est le même : tout ou rien.
   */
  enBloc(travail: () => Promise<void>): Promise<void>;
  fermer(): Promise<void>;
}

/**
 * Chiffrement au repos — docs/stockage.md §4.
 *
 * Seules les réponses et le contenu des référentiels passent par là. Les
 * identifiants, états et horodatages restent en clair : on n'indexe pas du
 * chiffré, et « lister les soumissions en attente » doit rester une requête,
 * pas un déchiffrement de toute la base.
 */
export interface Chiffreur {
  chiffrer(clair: string): string;
  dechiffrer(chiffre: string): string;
}

/**
 * Absence de chiffrement, pour les tests et le développement.
 *
 * Sur un appareil de terrain, un vrai chiffreur est obligatoire : le téléphone
 * se perd, et il contient des données personnelles d'enquêtés.
 */
export const CHIFFREUR_TRANSPARENT: Chiffreur = {
  chiffrer: (clair) => clair,
  dechiffrer: (chiffre) => chiffre,
};
