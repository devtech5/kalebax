# CLAUDE.md — Kalebax, plateforme de collecte de données terrain

## Vision du produit

SaaS de collecte de données terrain par des agents et des enquêteurs, conçu pour
l'Afrique. Un concepteur crée un formulaire depuis un navigateur, l'affecte à des
agents, les agents collectent sur leur téléphone **sans connexion**, les données
remontent dès que le réseau revient, le commanditaire suit l'avancement en temps
réel et exporte ses données quand il veut.

Le produit se livre sur **trois cibles** :

- **Web** — console de conception, de suivi et d'export, dans un navigateur.
- **Mobile** — application de collecte de l'agent, hors ligne, Android d'abord.
- **Desktop** — la console installable, doublée d'un **poste de saisie hors
  ligne** : bureau régional mal connecté, saisie de masse de questionnaires
  papier, vérification et correction des soumissions, export local.

Produit **autonome** : dépôt, base de données, authentification, facturation et
marque distincts de l'ERP Fiessou. Les deux produits partagent une philosophie et
des solutions techniques éprouvées, jamais une base de données.

Cibles, par ordre de priorité commerciale :

1. **Marketing opérationnel et audits de points de vente** — agences terrain,
   relevés de prix, visibilité en boutique, activations de marque.
2. **Sondages et études de marché** — instituts, enquêtes d'opinion, quotas.
3. **ONG et programmes de suivi-évaluation** — collecte de données de terrain,
   bailleurs exigeant des données traçables.
4. **Entreprises avec des équipes terrain** — recensements internes, inspections,
   contrôle qualité, relevés techniques.

## Différenciateurs (pourquoi pas KoboToolbox ou SurveyCTO)

Les outils existants sont techniquement solides. On ne gagne pas sur les
fonctionnalités de formulaire — on gagne sur tout ce qui les entoure :

- **Payable en FCFA par mobile money.** SurveyCTO facture en dollars par carte
  bancaire internationale : inaccessible à la majorité des agences locales.
- **Tarification au volume de soumissions, pas par agent.** Le client ne doit
  jamais être pénalisé financièrement pour étoffer son équipe terrain. (Modèle
  de référence : KoboToolbox.)
- **Souveraineté des données.** Hébergement dont l'emplacement est maîtrisé et
  communicable au client (zone OHADA en priorité, Europe à défaut). Argument
  décisif pour les bailleurs, les institutions et les données personnelles
  sensibles.
- **Vraiment hors-ligne, sur du vrai matériel.** Cible : Android d'entrée de
  gamme, 2 Go de RAM, stockage limité, plusieurs jours sans réseau. La
  synchronisation doit survivre à une coupure en plein milieu.
- **La vie de l'agent terrain est dans le produit.** Affectation par
  zone/mission, pointage, avances et paie journalière : ce qu'un chef de terrain
  gère aujourd'hui sur WhatsApp et dans un cahier. Aucun concurrent ne le fait.
- **WhatsApp/SMS comme canal**, pas l'email : affectation de mission, rappels de
  quota, alerte de fin de collecte.
- **Français d'abord.** Interface, support et documentation.

## Stack technique

Identique à Fiessou — solutions déjà éprouvées sur 29 sessions de production.

| Brique | Technologie |
|---|---|
| API | NestJS (Node.js + TypeScript) + PostgreSQL + Prisma |
| Console web | React + Vite (SPA) — concepteur de formulaires, suivi, export |
| Application agent | React Native / Expo (Android en priorité) |
| Application desktop | Tauri — embarque le bundle DOM de la console |
| Offline local | SQLite + moteur de synchronisation maison |
| Logique partagée | `packages/*` — schéma, évaluateur, runtime de saisie, stockage, sync |

**Trois cibles, deux rendus, un noyau.** Le desktop n'a pas d'interface propre :
il embarque le même bundle DOM que la console web. Le seul module écrit deux fois
est le rendu des types de questions — une fois en DOM (web et desktop), une fois
en React Native (mobile). Toute la logique — pertinence conditionnelle,
contraintes, calculs, brouillons, file de synchronisation — est écrite une seule
fois dans `packages/`.

**Tauri plutôt qu'Electron** : environ 10 Mo contre 150, consommation mémoire
très inférieure, s'appuie sur le WebView du système. La contrainte « vieux
matériel, faible RAM » vaut pour les postes de bureau comme pour les téléphones.
Contrepartie assumée : Rust dans la chaîne de production des binaires.

Structure du monorepo :

```
Kalebax/
├── CLAUDE.md
├── apps/
│   ├── api/            # NestJS
│   ├── web/            # console de conception et de suivi
│   ├── desktop/        # Tauri — console + poste de saisie hors ligne
│   └── mobile/         # application de collecte (Expo)
├── packages/
│   ├── shared/         # types, schéma de formulaire, évaluateur, validation
│   ├── form-runtime/   # état de saisie, navigation, calculs — sans rendu
│   ├── storage/        # port de persistance + adaptateurs par cible
│   ├── sync/           # file d'attente, lots, reprise sur coupure
│   ├── ui-web/         # rendu DOM des questions    → web + desktop
│   └── ui-native/      # rendu React Native         → mobile
└── docs/               # une spécification par module, rédigée AVANT de coder
```

`packages/storage` expose **une seule interface de persistance**, implémentée par
un adaptateur par cible : `expo-sqlite` sur mobile, SQLite natif sur desktop,
IndexedDB ou SQLite sur OPFS dans le navigateur. Aucun code métier n'appelle
jamais un moteur de stockage directement — sans cette règle, la synchronisation
serait à écrire trois fois.

## Règles fondamentales

- **Multi-tenant dès le jour 1.** Toute donnée appartient à une organisation
  (`organizationId`). Aucune table métier sans cette clé. Isolation stricte.
- **Les soumissions sont immuables.** Une donnée collectée n'est jamais écrasée
  silencieusement : toute correction crée une révision horodatée et attribuée.
  C'est la condition de crédibilité scientifique du produit — un bailleur ou un
  institut doit pouvoir auditer qui a modifié quoi.
- **Une soumission référence toujours la version exacte du formulaire** qui l'a
  produite. Sans cela, un formulaire modifié en cours de collecte rend le jeu de
  données ininterprétable.
- **UUID générés côté client** pour les soumissions et les pièces jointes, avec
  horodatage. La création est idempotente : rejouer une synchronisation ne
  duplique jamais une soumission.
- **Offline-first non négociable.** Toute fonction de collecte — sur téléphone
  comme sur poste de saisie desktop — fonctionne sans réseau. Le réseau est un
  détail de synchronisation, jamais une condition de fonctionnement.
- **Une expression s'évalue de façon identique sur les trois cibles et sur le
  serveur.** Logique conditionnelle, contraintes et calculs vivent dans
  `packages/shared` — une seule implémentation, jamais plusieurs moteurs à faire
  coïncider.
- **Aucune logique métier dans une application.** `apps/` ne contient que du
  câblage, de la navigation et du rendu. Toute règle qui doit valoir sur plus
  d'une cible vit dans `packages/` — sinon elle divergera entre le web, le
  mobile et le desktop.
- **Les montants sont des entiers.** FCFA sans décimales. Jamais de flottant
  pour l'argent (avances aux agents, budgets de mission).
- **Journal d'audit.** Publication d'un formulaire, modification d'une
  soumission, suppression d'un compte agent, export massif : qui, quoi, quand.
- **Aucune donnée client n'est supprimée à l'expiration d'un abonnement.** Le
  compte passe en lecture seule ; l'export reste toujours possible.

## Protection des données personnelles

Le produit collecte structurellement des données à caractère personnel, parfois
sensibles (santé, revenus, opinions, mineurs, géolocalisation d'individus). Ce
n'est pas un module : c'est une contrainte de conception.

- Conformité aux lois locales par pays (ARTCI et loi ivoirienne d'abord).
- Finalité déclarée par projet de collecte, consentement de l'enquêté
  matérialisable dans le formulaire (case, signature, enregistrement audio).
- Marquage des champs contenant des données personnelles au niveau du schéma —
  ce marquage pilote l'anonymisation à l'export et la purge programmée.
- Droit à l'export et à la suppression, exerçable sans passer par le support.
- Chiffrement au repos des soumissions et des pièces jointes.

## Souveraineté et dépendances

Même méthode que Fiessou. Avant toute dépendance tierce : « cela nous rend-il
dépendants d'un acteur étranger pour une fonction cœur ? »

- **Authentification 100% maison** : téléphone + OTP (SMS/WhatsApp) pour les
  agents, email/mot de passe pour les concepteurs. Argon2, JWT court + refresh.
  Le jeton reste valide localement plusieurs jours sans contact serveur
  (tolérance ~7 jours) — un agent en zone blanche ne doit jamais être bloqué par
  une expiration de session.
- **Paiements** : agrégateurs mobile money locaux (Wave, Orange Money, MTN MoMo,
  CinetPay, PayDunya).
- **Cartographie** : fonds de carte téléchargeables et hébergeables (OSM), pas de
  dépendance à une API cartographique propriétaire facturée à l'appel.
- **IA** : enrichissement ponctuel uniquement (résumé d'analyse, détection
  d'incohérences suggérée). Aucune fonction cœur — conception, collecte, sync,
  export — ne dépend d'un appel IA pour fonctionner.
- **Portabilité** : export intégral (CSV, Excel, JSON, médias) à tout moment.

## Propriété intellectuelle — à respecter strictement

**XLSForm** est un format de spécification ouvert : on peut l'importer, l'exporter
et s'y conformer sans contrainte. C'est même un impératif commercial (les ONG
arrivent avec des formulaires XLSForm existants).

**Le code de KoboToolbox et d'ODK est sous licence copyleft (AGPL/GPL).** On
s'inspire du modèle conceptuel, on ne réutilise aucune ligne de leur code sans
validation juridique préalable. Cette règle s'applique aussi aux extraits trouvés
dans des réponses en ligne.

## Conventions de développement

- **Une session = une fonctionnalité.** Jamais de demande géante.
- **Une spécification dans `docs/` avant de coder.**
- **Tests systématiques**, priorité absolue sur l'évaluateur d'expressions, la
  synchronisation et l'intégrité des soumissions — une donnée perdue ou corrompue
  est une faute produit irrécupérable.
- TypeScript strict partout. Validation des entrées à l'API (class-validator/Zod).
- Commits fréquents, messages clairs (français accepté).
- Interface sobre, gros boutons, utilisable sur petit écran et vieux matériel.

## Feuille de route

1. **Fondations** : moteur de formulaires (schéma, évaluateur, versionnage), API,
   authentification, multi-tenant.
2. **Boucle complète** : concepteur web + application agent + synchronisation
   offline + export. C'est le produit minimum démontrable.
3. **Desktop** : empaquetage Tauri de la console, adaptateur de stockage local,
   poste de saisie hors ligne.
4. **Terrain** : affectation par zone/mission, quotas, suivi temps réel, tableau
   de bord de collecte.
5. **Qualité et confiance** : détection d'anomalies (soumissions trop rapides,
   GPS incohérent, duplication), révisions, validation par superviseur.
6. **Monétisation** : licences au volume de soumissions, paiement mobile money.
7. **Ouverture** : import/export XLSForm, API publique, connecteurs Excel/Sheets.

## Commandes du projet

(À compléter au fur et à mesure de la mise en place.)

```bash
pnpm --filter api start:dev
pnpm --filter api test
pnpm --filter api prisma migrate dev
pnpm --filter web dev
pnpm --filter mobile android
pnpm --filter desktop dev
pnpm --filter desktop build
```
