# Spécification — Stockage local

Une seule interface de persistance, un adaptateur par cible. Sans cette règle, la
file de synchronisation serait à écrire trois fois — et elle divergerait, comme
divergent toujours trois implémentations d'une même règle.

## 1. Objectif

- **Aucun code métier n'appelle jamais un moteur de stockage directement.**
- Les trois cibles se comportent **à l'identique**, y compris dans les cas
  limites : extinction brutale, disque plein, écriture concurrente.
- Le chiffrement au repos est **transparent** pour le code métier.

| Cible | Moteur |
|---|---|
| mobile (Expo) | `expo-sqlite` |
| desktop (Tauri) | SQLite natif |
| navigateur | SQLite sur OPFS, IndexedDB en repli |
| tests, développement | mémoire, et `node:sqlite` |

## 2. Deux décisions qui portent tout le reste

### 2.1 Le SQL est écrit une seule fois

Les quatre moteurs qui comptent parlent tous SQLite : même dialecte, mêmes
types, mêmes contraintes. Ce qui diffère n'est pas le SQL mais la **façon de
l'exécuter** — synchrone ici, à promesses ailleurs, par pont natif sur mobile.

L'implémentation SQL est donc unique, paramétrée par un pilote minimal :

```ts
interface PiloteSql {
  executer(sql: string, parametres?: unknown[]): Promise<void>;
  interroger<T>(sql: string, parametres?: unknown[]): Promise<T[]>;
}
```

Trois pilotes d'une trentaine de lignes chacun, au lieu de trois implémentations
complètes du stockage. Le SQL des requêtes de synchronisation — la partie où une
erreur coûte des données — n'existe qu'en un seul exemplaire.

### 2.2 Pas de transaction générique dans l'interface

La tentation serait d'exposer `transaction(fn)`. **IndexedDB l'interdit en
pratique** : ses transactions se referment d'elles-mêmes dès qu'un `await`
extérieur rend la main, si bien qu'un code écrit et testé sur SQLite se
casserait silencieusement dans le navigateur — et se casserait à l'endroit
précis où l'on croyait garantir l'atomicité.

L'interface expose donc des **opérations atomiques de haut niveau**, une par
enchaînement qui doit réussir ou échouer d'un bloc :

```
finaliserSoumission(soumission, medias)   écrit la soumission, ses médias,
                                          et la met en file — ou rien
confirmerSoumission(id, statutServeur)    marque confirmée et libère les médias
```

L'adaptateur SQL les traduit en une transaction, l'adaptateur IndexedDB en une
transaction de son propre modèle. Le contrat est le même : tout ou rien.

## 3. Ce qui est stocké

| Entité | Contenu |
|---|---|
| `SoumissionLocale` | réponses, état de synchronisation, horodatages, position |
| `MediaLocal` | chemin du fichier, checksum, octets déjà envoyés |
| `VersionFormulaireLocale` | document JSON d'une version publiée ou retirée |
| `JeuDonneesLocal` | référentiel et sa version |
| `MetaLocale` | clé-valeur : dernière synchronisation, identifiant d'appareil |

Les états de `SoumissionLocale` sont ceux de `synchronisation.md` §4 :
`brouillon`, `en_attente`, `envoyee`, `confirmee`, `medias_en_attente`,
`echec_permanent`.

## 4. Chiffrement au repos

Un téléphone de terrain se perd et se vole, et il contient des données
personnelles d'enquêtés. Le chiffrement vit dans l'adaptateur, invisible du
métier.

**Ce qui est chiffré** : les réponses (`data`, `extraData`), et le contenu des
jeux de données.

**Ce qui ne l'est pas** : identifiants, états, horodatages, compteurs d'octets.
On n'indexe pas du chiffré, et « lister les soumissions en attente » doit rester
une requête, pas un déchiffrement de toute la base.

C'est le compromis assumé : un attaquant qui obtient la base apprend qu'une
collecte a eu lieu et quand, mais pas ce qui a été collecté.

## 5. Évolution du schéma local

Le schéma local change avec les versions de l'application, sur des appareils qui
sautent des versions. Numéro de version entier, migrations séquentielles
appliquées au démarrage, jamais de saut.

**Une migration ne supprime ni ne réécrit jamais une soumission non
synchronisée.** Une migration qui perd des données de terrain est un défaut
irrécupérable — préférer une colonne en trop, définitivement.

## 6. Conformité des adaptateurs

Le package exporte une **suite de conformité** : un jeu de tests unique que
chaque adaptateur doit passer. C'est la seule façon de garantir que les trois
cibles se comportent pareil.

Elle couvre : cycle de vie complet d'une soumission, atomicité des opérations
composées, ordre de la file, reprise d'un média à l'octet près, purge, isolation
des états, et le comportement après réouverture du magasin — c'est-à-dire après
une extinction brutale.

Un adaptateur qui ne passe pas la suite n'est pas un adaptateur.
