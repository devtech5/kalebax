# Spécification — Moteur de formulaires (session 1)

Module fondateur de Kalebax. Tout le reste du produit — application agent,
synchronisation, suivi terrain, export, facturation au volume — dépend du modèle
défini ici. C'est la spec à figer le plus soigneusement : un schéma de formulaire
mal conçu se paie sur toutes les sessions suivantes et sur les données déjà
collectées.

## 1. Objectif

- **Décrire un formulaire comme une donnée, pas comme du code.** Un formulaire
  est un document JSON versionné. L'application agent est un interpréteur
  générique : ajouter un type de question ne doit jamais exiger de republier
  l'application sur le Play Store.
- **Une seule implémentation de la logique.** Conditions d'affichage,
  contraintes de validation et champs calculés sont évalués par un moteur unique
  vivant dans `packages/shared`, exécuté à l'identique sur le téléphone (hors
  ligne) et sur le serveur (à la réception). Le serveur ne fait jamais confiance
  au client, mais il doit aboutir au même verdict que lui.
- **Versionnage strict.** Un formulaire publié est immuable. Une soumission
  référence la version exacte qui l'a produite, pour toujours.
- **Hors ligne d'abord.** Le document de formulaire et ses ressources
  (listes d'options, fonds de carte, médias) sont téléchargeables intégralement
  sur l'appareil avant le départ en mission.
- **Interopérable.** Le schéma doit pouvoir absorber un XLSForm existant et en
  produire un — condition d'entrée chez les ONG déjà équipées.

## 2. Hors périmètre (specs séparées)

- **Protocole de synchronisation** (lots, reprise sur coupure, upload différé
  des médias, résolution de conflits) — session dédiée. Ici on définit
  uniquement la *forme* d'une soumission, pas son voyage.
- **Concepteur visuel de formulaires** (interface web de glisser-déposer) —
  session dédiée. Ici on définit le document que ce concepteur produira.
- **Affectation aux agents, zones, quotas, suivi temps réel** — session dédiée.
- **Import/export XLSForm** — session dédiée, mais le schéma défini ici est
  conçu pour rendre la correspondance possible (voir §10).
- **Détection d'anomalies et validation par superviseur** — session dédiée.
- **Facturation au volume de soumissions** — session dédiée.

## 3. Concepts du domaine

```
Organization (tenant)
  └── Project            « Audit points de vente Abidjan T3 2026 »
        └── Form         « Relevé de linéaire »
              └── FormVersion   v1, v2, v3 — immuables
                    └── schéma JSON (groupes, questions, logique)
                          └── Submission   une visite d'un agent
                                └── Attachment  photos, audio, signature
```

- **Project** : le cadre d'une collecte — commanditaire, période, finalité
  déclarée du traitement de données personnelles, équipe.
- **Form** : identité stable et nom d'un formulaire. Ne contient aucune question.
- **FormVersion** : le document JSON figé. C'est l'objet que l'application
  télécharge et interprète.
- **Submission** : une réponse complète d'un agent, rattachée à une
  `FormVersion` précise.

## 4. Modèle de données (Prisma / PostgreSQL)

### Project

```
id                uuid (PK)
organizationId    uuid (FK) — isolation multi-tenant
name              string
description       string (nullable)
status            enum ProjectStatus (draft, active, paused, closed)
purpose           string (nullable) — finalité déclarée du traitement (RGPD/ARTCI)
startsAt          date (nullable)
endsAt            date (nullable)
createdByUserId   uuid (FK)
createdAt         timestamp
```

Index : `(organizationId, status)`.

### Form

```
id                 uuid (PK)
organizationId     uuid (FK)
projectId          uuid (FK)
name               string
currentVersionId   uuid (nullable, FK -> FormVersion) — version publiée en cours
createdByUserId    uuid (FK)
createdAt          timestamp
archivedAt         timestamp (nullable)
```

Index : `(organizationId, projectId)`.

### FormVersion

```
id                uuid (PK)
organizationId    uuid (FK)
formId            uuid (FK)
versionNumber     int — 1, 2, 3... unique par formId
schema            jsonb — le document de formulaire (§5)
status            enum FormVersionStatus (draft, published, retired)
breakingChange    bool — incompatible avec la version précédente (§7)
publishedAt       timestamp (nullable)
publishedByUserId uuid (nullable, FK)
createdAt         timestamp
```

Contrainte d'unicité : `(formId, versionNumber)`.
**Une `FormVersion` en statut `published` n'est jamais modifiable** — aucune
route d'écriture ne l'accepte, y compris pour l'administrateur de
l'organisation. Corriger, c'est publier une version suivante.

### Submission

```
id                uuid (PK — GÉNÉRÉ CÔTÉ CLIENT, offline)
organizationId    uuid (FK)
projectId         uuid (FK)
formVersionId     uuid (FK) — version exacte ayant produit la donnée
data              jsonb — réponses, indexées par `name` de question
status            enum SubmissionStatus (received, validated, rejected)
revision          int — 1 à la réception, incrémenté à chaque correction
collectedByUserId uuid (FK) — l'agent
startedAt         timestamp — début de saisie (horloge de l'appareil)
completedAt       timestamp — fin de saisie (horloge de l'appareil)
receivedAt        timestamp — réception serveur (horloge serveur, fait foi)
durationSeconds   int — calculé, matière première de la détection d'anomalies
deviceId          string (nullable)
appVersion        string (nullable)
startLatitude     decimal (nullable) — position à l'ouverture du formulaire
startLongitude    decimal (nullable)
startAccuracy     decimal (nullable) — précision en mètres de cette position
startGeopointStatus enum (captured, denied, unavailable, timeout, skipped)
createdAt         timestamp
```

`startGeopointStatus` documente ce qui s'est passé quand la position n'a pas été
capturée. **Un agent n'est jamais bloqué par une défaillance technique** : si
`requireStartGeopoint` est vrai et que la capture échoue, la soumission part
quand même, l'échec est enregistré, et un superviseur tranche depuis la console.
Ce champ est aussi un signal de qualité — un agent dont toutes les soumissions
portent `denied` a désactivé sa localisation, et cela se voit immédiatement.

`startAccuracy` distingue une position satellite à 5 mètres d'une position
obtenue par triangulation réseau à 1500 mètres. Sans elle, les deux sont
indiscernables dans les données, et un contrôle de cohérence géographique n'a
aucun sens.

Index : `(organizationId, projectId, receivedAt)`, `(formVersionId)`,
`(collectedByUserId, receivedAt)`.

`startedAt` et `completedAt` viennent de l'horloge de l'appareil et **ne sont pas
fiables** (horloge déréglée, fuseau, manipulation). `receivedAt` est la seule
référence temporelle serveur. Les deux sont conservées : leur écart est en
lui-même un signal de qualité.

### SubmissionRevision

Immuabilité des données : toute correction après réception crée une révision.

```
id                uuid (PK)
submissionId      uuid (FK)
revision          int
data              jsonb — état complet des données APRÈS la modification
changedFields     jsonb — { champ: { avant, après } }
reason            string (nullable)
changedByUserId   uuid (FK)
changedAt         timestamp
```

La révision 1 est écrite à la réception : l'état d'origine tel que l'agent l'a
soumis est donc toujours récupérable, quoi qu'il arrive ensuite.

### Attachment

```
id                uuid (PK — généré côté client)
organizationId    uuid (FK)
submissionId      uuid (FK)
questionName      string — la question qui a produit le média
kind              enum AttachmentKind (photo, audio, video, signature, file)
storageKey        string — chemin dans le stockage objet
mimeType          string
sizeBytes         int
checksum          string — SHA-256, vérifie l'intégrité après upload différé
capturedAt        timestamp (nullable)
latitude          decimal (nullable)
longitude         decimal (nullable)
uploadedAt        timestamp (nullable) — null tant que le média n'est pas monté
```

Une soumission est acceptée **sans** ses médias : le texte remonte en quelques
kilo-octets sur un réseau dégradé, les photos suivent quand le réseau le permet.
Les enregistrements `Attachment` sont donc créés à la réception de la soumission,
avec `uploadedAt` à null.

### QuestionLibraryItem

Bibliothèque de questions réutilisables — indicateurs standardisés qu'une
organisation réemploie d'une enquête à l'autre.

```
id                uuid (PK)
organizationId    uuid (FK)
name              string — identifiant de variable proposé par défaut
definition        jsonb — une question au format §5.2
tags              string[]
createdByUserId   uuid (FK)
createdAt         timestamp
```

## 5. Le document de formulaire

### 5.1 Enveloppe

```json
{
  "schemaVersion": 1,
  "title": { "fr": "Relevé de linéaire", "en": "Shelf audit" },
  "defaultLanguage": "fr",
  "languages": ["fr", "en"],
  "settings": {
    "requireStartGeopoint": true,
    "minGeopointAccuracy": 50,
    "allowDraftSave": true,
    "singleSubmissionPerAssignment": false
  },
  "children": [ /* groupes et questions, dans l'ordre d'affichage */ ]
}
```

`schemaVersion` est la version du **format** lui-même (pas du formulaire) : il
permettra à une application ancienne de refuser proprement un document trop
récent au lieu de l'interpréter de travers.

Tout libellé visible est un objet multilingue `{ "fr": "...", "en": "..." }`.
L'agent choisit sa langue dans l'application ; le repli se fait sur
`defaultLanguage`.

### 5.2 Question

```json
{
  "id": "q_a1b2c3",
  "name": "prix_unitaire",
  "type": "integer",
  "label": { "fr": "Prix unitaire relevé (FCFA)" },
  "hint": { "fr": "Prix affiché en rayon, hors promotion" },
  "required": true,
  "relevant": "${produit_present} = 'oui'",
  "constraint": ". > 0 and . < 1000000",
  "constraintMessage": { "fr": "Prix invalide" },
  "default": null,
  "readOnly": false,
  "appearance": "numpad",
  "personalData": false,
  "locked": false
}
```

- **`id`** : identifiant technique **stable et jamais réutilisé**, généré à la
  création. Il survit aux renommages et sert à suivre une question d'une version
  à l'autre.
- **`name`** : le nom de la variable dans les exports. Unique dans le formulaire,
  format `[a-z_][a-z0-9_]*`. C'est le nom que verra le statisticien : il est
  choisi par le concepteur, pas généré.
- **`personalData`** : marque un champ contenant une donnée à caractère
  personnel. Pilote l'anonymisation à l'export et la purge programmée (voir
  CLAUDE.md, protection des données personnelles).
- **`locked`** : verrouillage de modèle. Dans une grande équipe, le concepteur
  principal verrouille les questions qui garantissent la comparabilité des
  données ; les autres rôles ne peuvent ni les modifier ni les supprimer, mais
  peuvent ajouter les leurs.

Attributs propres à certains types : `calculation` sur un `calculate`,
`optionsSource` et `options` sur les questions à choix (§5.5), `minCount` et
`maxCount` sur les questions média (§5.6). Les porter sur un autre type est
refusé à la publication — un attribut sans effet est presque toujours le signe
d'une erreur de conception, pas d'une intention.

### 5.3 Types de questions

| Type | Donnée stockée | Notes |
|---|---|---|
| `text` | string | `appearance: "multiline"` pour un texte long |
| `integer` | int | **obligatoire pour tout montant** (FCFA, entier) |
| `decimal` | number | mesures, coordonnées — jamais de l'argent |
| `date`, `time`, `datetime` | ISO 8601 | |
| `select_one` | string (valeur d'option) | |
| `select_multiple` | string[] | |
| `rank` | string[] ordonné | classement d'options |
| `geopoint` | `{ lat, lng, accuracy, altitude }` | précision GPS conservée, elle sert au contrôle qualité |
| `geotrace` | geopoint[] | parcours |
| `geoshape` | geopoint[] fermé | parcelle, zone |
| `photo`, `audio`, `video`, `file` | id[] d'`Attachment` | `minCount` / `maxCount` — voir §5.6 |
| `signature` | id d'`Attachment` | consentement de l'enquêté, réception de matériel |
| `barcode` | string | code-barres produit, QR d'identification |
| `calculate` | dépend de l'expression | non saisi, jamais affiché ; porte son expression dans l'attribut `calculation` |
| `note` | — | texte d'information, aucune donnée |
| `group` | — | section, avec ses `children` |
| `repeat` | tableau d'objets | groupe répétable (§5.4) |

### 5.4 Groupes et répétitions

```json
{
  "id": "g_produits",
  "name": "produits",
  "type": "repeat",
  "label": { "fr": "Produits relevés" },
  "repeatCount": "${nombre_produits}",
  "minRepeat": 1,
  "maxRepeat": 50,
  "children": [ /* questions répétées */ ]
}
```

Les données d'un `repeat` sont stockées en tableau d'objets dans `data`. Le
`repeatCount` peut être fixe, piloté par une expression, ou libre (l'agent
ajoute autant d'occurrences qu'il veut). `maxRepeat` est obligatoire en pratique :
sans plafond, un formulaire peut saturer la mémoire d'un téléphone d'entrée de
gamme en pleine collecte.

Les répétitions imbriquées sont **limitées à deux niveaux** en v1 — au-delà,
l'ergonomie sur petit écran et l'aplatissement à l'export deviennent
ingérables.

### 5.5 Listes d'options

```json
{
  "id": "q_region",
  "name": "region",
  "type": "select_one",
  "optionsSource": { "kind": "inline" },
  "options": [
    { "value": "abidjan", "label": { "fr": "Abidjan" } },
    { "value": "bouake",  "label": { "fr": "Bouaké" } }
  ]
}
```

Trois sources d'options :

- **`inline`** — la liste est dans le document.
- **`dataset`** — la liste vient d'un jeu de données de l'organisation
  (référentiel de produits, de points de vente, de localités). Téléchargé sur
  l'appareil avec le formulaire, mis à jour indépendamment de la version du
  formulaire. Indispensable : un référentiel de 4 000 boutiques ne peut pas
  vivre dans le document de formulaire, et sa mise à jour ne doit pas forcer
  une nouvelle version.
- **`cascade`** — filtrage en cascade sur un `dataset` (région → département →
  ville), via `filter: "region = ${region}"`.

**Option d'échappement — « Autre, précisez ».** Une liste fermée doit presque
toujours offrir une issue textuelle : c'est le motif le plus répandu de toute
enquête terrain. Il se déclare **au niveau de l'option**, pas de la question.

```json
{
  "value": "autre",
  "label": { "fr": "Autre" },
  "allowFreeText": true,
  "freeTextLabel": { "fr": "Précisez" }
}
```

Le texte saisi est stocké dans une clé dérivée `<name>_autre` et **jamais
mélangé à la valeur de l'option**. Sans cette séparation, le statisticien
retrouve du texte libre dans une variable catégorielle et son analyse est à
refaire. La clé dérivée est une colonne à part entière à l'export.

Déclarer l'échappement sur l'option plutôt que sur la question permet plusieurs
issues distinctes dans une même liste et rend la correspondance XLSForm
(`or_other`) mécanique dans les deux sens.

Une option d'échappement se range **toujours en fin de liste**, quel que soit
l'ordre de tri appliqué aux autres options.

## 5.6 Questions média multiples

`photo`, `audio`, `video` et `file` acceptent plusieurs pièces jointes pour une
même question — photographier un incident sous trois angles ou relever un
linéaire de rayon en plusieurs clichés est le cas courant, pas l'exception.

```json
{
  "id": "q_photos",
  "name": "photos",
  "type": "photo",
  "label": { "fr": "Photos" },
  "minCount": 0,
  "maxCount": 5
}
```

La donnée stockée est un **tableau** d'identifiants d'`Attachment`, dans l'ordre
de capture. `maxCount` est obligatoire : sans plafond, une équipe qui prend
trente photos par visite sature le stockage d'un téléphone d'entrée de gamme en
une journée de collecte.

Un `repeat` d'une seule question média produirait le même résultat, mais impose
une navigation lourde sur petit écran pour un besoin trivial.

## 6. Langage d'expressions

Utilisé par `relevant`, `constraint`, `required` (conditionnel), `default`,
`repeatCount` et les questions `calculate`.

**Décision : mini-langage maison, pas XPath.** XLSForm utilise XPath, hérité
d'ODK. XPath sur un document JSON impose de simuler un arbre XML, la
bibliothèque est lourde pour du React Native, et le sous-ensemble réellement
utilisé sur le terrain tient en une trentaine de fonctions. On implémente donc
un évaluateur dédié dans `packages/shared` :

- **analyse syntaxique explicite vers un AST, jamais `eval` ni `new Function`** —
  un formulaire est une donnée fournie par un utilisateur, l'exécuter serait une
  faille d'exécution de code arbitraire côté serveur ;
- **aucun effet de bord, aucun accès réseau ou système** ;
- **déterministe** : mêmes entrées, même résultat sur le téléphone et sur le
  serveur — sauf `today()` et `now()`, dont la valeur est figée au démarrage de
  la saisie et transportée avec la soumission ;
- **budget d'exécution borné** (profondeur, nombre de nœuds) pour qu'une
  expression pathologique ne fige pas l'application d'un agent.

Grammaire :

- Référence à une réponse : `${nom_question}` ; `.` désigne la question courante
  (dans `constraint`).
- Littéraux : nombres, chaînes `'...'`, `true`/`false`, `null`.
- Opérateurs : `= != < <= > >=`, `+ - * / mod`, `and or not()`, parenthèses.
- Fonctions : `if(cond, a, b)`, `selected(champ, 'valeur')`, `count()`,
  `count-selected()`, `sum()`, `min()`, `max()`, `round()`, `int()`,
  `number()`, `string-length()`, `substr()`, `concat()`, `regex()`,
  `today()`, `now()`, `date-diff()`, `coalesce()`.

Toute expression est validée **à la publication** du formulaire : références à
des questions inexistantes, cycles de dépendances, types incompatibles et
fonctions inconnues bloquent la publication. Une erreur d'expression découverte
par un agent à 300 km du bureau est un échec produit.

## 7. Cycle de vie et versionnage

```
draft ──publier──> published ──publier v+1──> retired
  │                                              │
  └── modifiable librement                       └── lecture seule, données conservées
```

Une version publiée est immuable. Publier crée `versionNumber + 1`.

**Changements compatibles** (l'agent peut continuer une saisie en cours) :
ajout d'une question optionnelle, modification d'un libellé, d'une aide, d'une
apparence, ajout d'une option, assouplissement d'une contrainte.

**Changements incompatibles** (`breakingChange: true`) : suppression d'une
question, changement de `type` ou de `name`, passage en `required`, durcissement
d'une contrainte, suppression d'une option déjà utilisée.

Comportement à la publication :

- Les soumissions déjà reçues ne sont **jamais** migrées ni retouchées : elles
  restent attachées à leur version.
- L'application agent télécharge la nouvelle version au prochain contact réseau.
- Les brouillons locaux commencés sur l'ancienne version sont conservés et
  restent saisissables et soumettables sur cette ancienne version. Interrompre
  un agent en cours de visite pour cause de mise à jour de formulaire est
  inacceptable ; le serveur accepte donc les soumissions de toute version
  `published` ou `retired` du formulaire.
- Un `breakingChange` déclenche un avertissement explicite au concepteur, avec
  la liste des ruptures détectées et le nombre de soumissions déjà collectées.

L'export d'un projet couvrant plusieurs versions est traité par la spec
d'export : les colonnes sont l'union des `name` de toutes les versions, les
champs absents d'une version sont vides.

## 8. Validation à la réception

Le serveur revalide intégralement toute soumission reçue, avec le même
évaluateur que le client :

1. La `FormVersion` existe, appartient à l'organisation, statut `published` ou
   `retired`.
2. Les clés de `data` correspondent à des `name` du schéma ; les clés inconnues
   sont **conservées** dans un champ `extraData` plutôt que rejetées — une
   donnée collectée par un agent ne se jette pas.
3. Types conformes, options existantes, cardinalité des `repeat` respectée.
4. `relevant` réévalué : une question non pertinente doit être vide.
5. `required` et `constraint` réévalués.
6. Idempotence : si l'`id` de soumission existe déjà pour cette organisation, la
   requête renvoie la soumission existante en `200` sans rien modifier.

En cas d'échec de validation métier (points 3 à 5), la soumission est
**enregistrée quand même** avec `status: rejected` et le détail des violations.
Perdre une donnée de terrain parce qu'elle ne passe pas une contrainte est pire
que la conserver pour arbitrage humain : un superviseur tranche depuis la
console.

## 9. API

```
POST   /projects                              créer un projet
GET    /projects                              lister
POST   /projects/:id/forms                    créer un formulaire (v1 en draft)
GET    /forms/:id/versions                    historique des versions
PATCH  /form-versions/:id                     modifier — refusé si published
POST   /form-versions/:id/publish             valider les expressions puis publier
POST   /forms/:id/versions                    nouvelle version depuis la courante
GET    /forms/:id/current                     document de la version publiée
GET    /projects/:id/bundle                   paquet hors-ligne : formulaires
                                              publiés + datasets + version des
                                              référentiels (pour l'app agent)
POST   /submissions                           soumettre (idempotent sur l'id)
GET    /submissions                           lister, filtrer
PATCH  /submissions/:id                       correction — crée une révision
GET    /submissions/:id/revisions             historique complet
POST   /submissions/:id/attachments/:aid      upload différé d'un média
```

Toutes les routes sont filtrées par `organizationId` issu du jeton, jamais du
corps de la requête.

## 10. Correspondance XLSForm

Le schéma ci-dessus est conçu pour que la conversion soit mécanique (session
dédiée). Correspondances directes : `name`, `type`, `label`, `hint`,
`required`, `relevant`, `constraint`, `constraint_message`, `calculation`,
`appearance`, `choice_filter`, feuille `choices` → `options`, feuille
`settings` → enveloppe.

Points de friction à traiter dans la session dédiée : les expressions XPath
doivent être traduites vers le langage du §6 (le sous-ensemble courant est
couvert, les expressions XPath exotiques seront signalées à l'import plutôt que
mal converties), et XLSForm n'a pas d'équivalent de `id` stable — un import
génère donc de nouveaux identifiants.

## 11. Tests (priorité absolue)

- **Évaluateur d'expressions** : jeu de cas exhaustif par fonction et par
  opérateur, valeurs nulles, types mixtes, division par zéro, expressions
  malveillantes (profondeur, taille), non-régression sur chaque cas réel
  rencontré. Le même jeu de tests tourne dans `packages/shared` et est rejoué
  côté mobile.
- **Détection de cycles** dans les dépendances entre questions.
- **Immuabilité** : toute tentative d'écriture sur une `FormVersion` publiée est
  rejetée ; toute modification de soumission crée une révision et conserve
  l'état d'origine.
- **Idempotence** : rejouer dix fois la même soumission produit une ligne.
- **Isolation multi-tenant** : aucune route n'expose une donnée d'une autre
  organisation, y compris par identifiant deviné.
- **Compatibilité de version** : une soumission sur une version `retired` est
  acceptée ; une soumission sur une version `draft` est refusée.
- **Option d'échappement** : le texte de `<name>_autre` n'est jamais écrit dans
  la variable catégorielle ; il n'est accepté que si l'option retenue porte
  `allowFreeText` ; il apparaît en colonne distincte à l'export.
- **Médias multiples** : `maxCount` est respecté à la réception, l'ordre de
  capture est conservé, et une soumission reste valide tant que ses pièces
  jointes ne sont pas encore montées.
- **Échec de capture GPS** : une soumission dont `startGeopointStatus` vaut
  `denied` ou `unavailable` est acceptée même lorsque `requireStartGeopoint` est
  vrai — un agent n'est jamais bloqué par une défaillance technique.
