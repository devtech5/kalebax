# Analyse de SIGNALE — ce que Kalebax en retient

SIGNALE est une application de signalement citoyen d'incidents urbains (nids de
poule, dépôts sauvages, lampadaires hors service), inspirée de KoboCollect. Elle
sert ici de **cas de test du schéma de formulaire** : si Kalebax ne sait pas
produire SIGNALE sans écrire une ligne de code applicatif, le schéma est
incomplet.

Le test a révélé deux manques structurels, corrigés dans `formulaires.md`.

## 1. Réserve de propriété intellectuelle

SIGNALE se déclare inspirée de KoboCollect. **L'inspiration conceptuelle est
libre ; la réutilisation de code ne l'est pas.** Le code d'ODK et de KoboToolbox
est sous licence AGPL/GPL, et ce copyleft se propagerait à l'ensemble de Kalebax
s'il y entrait par un intermédiaire.

**Point vérifié le 13 août 2026 :** SIGNALE ne reprend que des idées de
KoboCollect, aucune ligne de son code. La voie est donc libre — du code SIGNALE
peut être repris dans Kalebax sans contrainte de licence.

Cette analyse ne reprend de toute façon **aucun code** : elle observe des choix
d'interface et des besoins métier, et en tire des décisions de conception
propres.

## 2. La différence de nature

| | SIGNALE | Kalebax |
|---|---|---|
| Le formulaire est | codé dans l'application | une donnée versionnée |
| Ajouter un champ demande | une republication Play Store | une publication de version |
| Les catégories vivent | dans une table applicative | dans un dataset d'organisation |
| Le rendu est | écrit à la main par écran | un interpréteur générique |

C'est la raison d'être de Kalebax, et SIGNALE en donne l'illustration : ses
catégories se sont retrouvées polluées par des libellés d'un autre domaine
(« En clientèle », « En réunion », « Sur le terrain » listés comme catégories
d'incident, à côté de « Nid de poule »). Sans isolation multi-tenant ni dataset
versionné, rien ne s'y oppose. Kalebax rend ce mélange structurellement
impossible : une liste d'options vient soit du document de formulaire, soit d'un
dataset porteur d'un `organizationId`.

## 3. Manques révélés dans le schéma Kalebax

### 3.1 « Autre — préciser » — MANQUE MAJEUR

Dans SIGNALE, choisir la catégorie « Autres » fait apparaître un champ libre
« Nom de la catégorie ». C'est le motif le plus répandu de toute enquête
terrain : une liste fermée, plus une échappatoire textuelle. XLSForm le traite
par `or_other`, et **la spec Kalebax n'avait rien**.

Décision : le porter **au niveau de l'option**, pas du formulaire.

```json
{
  "value": "autre",
  "label": { "fr": "Autre" },
  "allowFreeText": true,
  "freeTextLabel": { "fr": "Précisez" }
}
```

Le texte saisi est stocké dans une clé dérivée `<name>_autre`, jamais mélangé à
la valeur de l'option — sinon le statisticien retrouve du texte libre dans une
variable catégorielle et son analyse est à refaire. La clé dérivée est une
colonne à part entière à l'export.

Le porter au niveau de l'option plutôt que de la question permet à un formulaire
d'avoir plusieurs échappatoires distinctes (« Autre produit », « Autre motif »)
dans une même liste, et rend la conversion XLSForm mécanique dans les deux sens.

### 3.2 Plusieurs médias pour une même question — MANQUE

SIGNALE annonce « Photos (optionnel, max 5) ». Le schéma Kalebax faisait
correspondre le type `photo` à **un** identifiant d'`Attachment`. Or photographier
un incident sous plusieurs angles, ou relever un linéaire de rayon en trois
clichés, est le cas courant, pas l'exception.

Passer par un `repeat` d'une seule question fonctionnerait mais impose une
navigation lourde sur petit écran pour un besoin trivial.

Décision : `minCount` et `maxCount` sur les types média. La donnée stockée
devient un tableau d'identifiants d'`Attachment`. `maxCount` est **obligatoire** :
sans plafond, cinq agents qui prennent trente photos saturent le stockage d'un
téléphone d'entrée de gamme en une journée de collecte.

### 3.3 Échec de capture GPS — MANQUE

SIGNALE affiche « Localisation non disponible » en rouge, un message invitant à
activer le service — et **aucune issue** : ni saisie manuelle, ni point sur une
carte, ni possibilité de continuer. L'utilisateur est bloqué.

Kalebax a `settings.requireStartGeopoint`, mais rien sur ce qui se passe quand la
capture échoue. La règle produit tranche : **un agent n'est jamais bloqué par une
défaillance technique.** Une soumission part toujours, l'échec est enregistré et
tranché plus tard par un superviseur.

Champs ajoutés à `Submission` :

```
startAccuracy         decimal (nullable) — précision en mètres
startGeopointStatus   enum (captured, denied, unavailable, timeout, skipped)
```

`startGeopointStatus` est aussi un signal de qualité : un agent dont toutes les
soumissions portent `denied` a désactivé sa localisation, ce qui se voit
immédiatement depuis la console.

### 3.4 La précision GPS doit être montrée, pas seulement stockée

SIGNALE affiche le point capturé sous forme de coordonnées brutes
(`Lat: 5.333862 / Lng: -4.070250`) sans indication de précision. Une position
obtenue par triangulation réseau à ±1500 m s'affiche exactement comme une
position satellite à ±5 m. Pour un incident que des services techniques doivent
retrouver sur le terrain, c'est la différence entre une donnée exploitable et une
donnée inutile.

Kalebax conservait déjà `accuracy` sur le type `geopoint`. La décision ajoutée
est d'interface : **la précision est affichée à l'agent au moment de la capture**,
avec un seuil configurable au niveau du formulaire au-delà duquel la capture est
signalée comme insuffisante et peut être relancée.

Des coordonnées décimales ne veulent rien dire pour la personne qui collecte :
elle ne peut pas vérifier que le point correspond à l'endroit où elle se trouve.
Le rendu montre un repère sur un fond de carte hors ligne (OSM, conformément à
CLAUDE.md), et non une paire de nombres.

## 4. Décisions d'interface reprises

Éléments de SIGNALE à conserver dans l'application agent Kalebax.

- **Bloc de statut en tête de formulaire.** La capture de position vit dans un
  encart dédié avant les questions, avec trois états visuellement distincts
  (en cours, capturée, indisponible) et un bouton de re-capture manuelle. Un
  agent doit pouvoir relancer une capture qu'il juge mauvaise.
- **Synchronisation automatique *et* bouton « synchroniser maintenant ».** Les
  deux sont nécessaires : l'agent sait mieux que l'application à quel moment il
  a du réseau, et il ne fait pas confiance à un automatisme invisible. Le bouton
  manuel est un dispositif de confiance autant qu'une fonction.
- **Version de l'application visible dans le profil.** Première question de tout
  support terrain. Kalebax l'enregistre déjà dans `appVersion` sur la soumission ;
  elle doit aussi être lisible par l'agent.
- **Rôle affiché sur le profil.** SIGNALE affiche « Citoyen ». Kalebax affichera
  concepteur, agent ou superviseur — utile au support pour comprendre en une
  question ce que la personne peut ou ne peut pas faire.
- **Écran vide porteur d'une action.** « Aucun signalement — créez votre premier »
  avec le bouton dans l'écran. À reprendre pour la liste des missions.
- **Choix de langue dans les paramètres.** Attention à ne pas confondre deux
  notions distinctes : la langue de l'**interface** (paramètre de l'appareil) et
  la langue du **formulaire** (déclarée dans le document, §5.1). Un agent peut
  vouloir une interface en français et un questionnaire administré en dioula.

## 5. Défauts à ne pas reproduire

- **Aucune distinction entre envoyé et en attente** dans la liste des
  signalements, alors que l'application propose une synchronisation. L'agent ne
  sait pas si sa donnée est partie. Dans Kalebax, l'état de synchronisation de
  chaque soumission est visible dans la liste : c'est la condition de confiance
  de quelqu'un qui a passé sa journée à collecter.
- **« Vider le cache » sans garde-fou.** SIGNALE rassure : « les données du
  serveur ne seront pas affectées ». Sur Kalebax, la phrase serait un mensonge
  dangereux — les soumissions non synchronisées n'existent nulle part ailleurs
  que sur l'appareil. Règle : **le vidage refuse de s'exécuter tant qu'il reste
  une soumission non synchronisée**, et le dit en nombre exact.
- **Catégorie fourre-tout mal classée.** SIGNALE trie ses options par ordre
  alphabétique brut, ce qui place « Autres » en troisième position. Une option
  d'échappement se range toujours en fin de liste, quel que soit le tri.
- **Pas de récupération de mot de passe.** Le problème disparaît largement dans
  Kalebax : les agents s'authentifient par téléphone et OTP, sans mot de passe à
  perdre. Bonne validation du choix d'authentification.

## 6. SIGNALE exprimé en schéma Kalebax

Vérification que le schéma, une fois amendé, produit SIGNALE sans code.

```json
{
  "schemaVersion": 1,
  "title": { "fr": "Signalement d'incident urbain" },
  "defaultLanguage": "fr",
  "languages": ["fr", "en"],
  "settings": {
    "requireStartGeopoint": true,
    "minGeopointAccuracy": 50,
    "allowDraftSave": true
  },
  "children": [
    {
      "id": "q_categorie",
      "name": "categorie",
      "type": "select_one",
      "label": { "fr": "Catégorie" },
      "required": true,
      "optionsSource": { "kind": "dataset", "dataset": "categories_incidents" }
    },
    {
      "id": "q_description",
      "name": "description",
      "type": "text",
      "label": { "fr": "Description" },
      "hint": { "fr": "Décrivez l'incident en détail" },
      "appearance": "multiline",
      "required": true
    },
    {
      "id": "q_photos",
      "name": "photos",
      "type": "photo",
      "label": { "fr": "Photos" },
      "required": false,
      "maxCount": 5
    }
  ]
}
```

Le dataset `categories_incidents` porte l'option d'échappement :

```json
{ "value": "autre", "label": { "fr": "Autre" }, "allowFreeText": true }
```

Trois questions, aucun code applicatif. Une nouvelle catégorie d'incident se
publie par mise à jour du dataset, sans nouvelle version du formulaire et sans
passage par le Play Store — ce qui, dans SIGNALE, aurait évité la pollution de la
liste : le dataset appartient à une organisation et n'a aucun moyen de recevoir
les statuts d'activité d'un autre produit.
