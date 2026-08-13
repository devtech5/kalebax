# Spécification — Jeux de données

`formulaires.md` §5.5 fait des jeux de données une des trois sources d'options,
et `synchronisation.md` §7.1 prévoit leur descente différentielle. Le modèle de
données ne les avait jamais définis : ce document comble ce trou.

## 1. Pourquoi ils existent

Un référentiel de 4 000 points de vente ne peut pas vivre dans le document de
formulaire. Deux raisons, chacune suffisante :

- **Le poids.** Le document serait retéléchargé en entier à chaque
  synchronisation, sur un réseau facturé au mégaoctet.
- **Le rythme.** Une boutique ouvre, une autre ferme. Si le référentiel vivait
  dans le formulaire, chaque changement imposerait de publier une version — et
  couperait les soumissions déjà commencées de leur formulaire.

**Un jeu de données se met donc à jour indépendamment de la version du
formulaire.** C'est toute sa raison d'être.

## 2. Modèle de données

### Dataset

```
id                uuid (PK)
organizationId    uuid (FK)
name              string — identifiant technique, `[a-z_][a-z0-9_]*`
label             string — nom lisible
version           int — incrémentée à chaque import
entryCount        int — entrées vivantes, pour l'affichage et les quotas
updatedAt         timestamp
createdAt         timestamp
```

Unicité : `(organizationId, name)`.

### DatasetEntry

```
id                uuid (PK)
organizationId    uuid (FK)
datasetId         uuid (FK)
value             string — la valeur stockée dans les soumissions
label             string — ce que voit l'agent
attributes        jsonb — attributs plats, support du filtrage en cascade
version           int — version où cette entrée est apparue ou a changé
deletedAtVersion  int (nullable) — version où elle a été retirée
```

Unicité : `(datasetId, value)`.

### Les entrées ne sont jamais supprimées

`deletedAtVersion` est une suppression **logique**, et c'est ce qui rend le
différentiel possible : un appareil qui revient avec la version 12 doit
apprendre non seulement ce qui a été ajouté, mais aussi ce qui a disparu. Une
suppression physique ne laisserait aucune trace à lui transmettre.

C'est aussi ce qui permet d'interpréter une soumission ancienne : la boutique
choisie il y a trois mois a fermé, son libellé reste lisible.

## 3. Différentiel

L'appareil annonce `points_vente:12`, le serveur renvoie :

```json
{
  "nom": "points_vente",
  "version": 15,
  "mode": "delta",
  "ajoutees": [ { "value": "pv-4012", "label": "Boutique Awa", "attributes": {} } ],
  "retirees": ["pv-3980"]
}
```

Une entrée modifiée apparaît dans `ajoutees` : l'appareil remplace par valeur,
il n'a pas besoin de savoir que c'est une modification plutôt qu'un ajout.

**Le serveur bascule en envoi intégral** — `mode: "complet"` — quand le delta
approche la taille du jeu entier. Un appareil qui revient après six semaines
recevrait sinon un différentiel plus lourd que l'original. Le seuil est de
**60 % des entrées vivantes**.

Un appareil qui ne détient rien reçoit évidemment l'intégral.

## 4. Import

L'import remplace le contenu et incrémente la version, en une transaction :

1. Les valeurs absentes du nouveau lot sont marquées `deletedAtVersion = v+1`.
2. Les valeurs nouvelles ou dont le libellé ou les attributs ont changé sont
   écrites avec `version = v+1`.
3. Les valeurs identiques ne sont pas touchées — sans quoi chaque import
   produirait un delta complet et annulerait tout l'intérêt du différentiel.

Une entrée retirée puis réintroduite reprend la même ligne : `deletedAtVersion`
repasse à nul. Créer une seconde ligne pour la même valeur casserait l'unicité
et l'historique.

**Un import qui ne change rien n'incrémente pas la version.** Sinon un
rafraîchissement quotidien automatique ferait retélécharger un delta vide à
tous les appareils, chaque jour.

## 5. Filtrage en cascade

`attributes` est un objet **plat** — chaînes, nombres, booléens — et pas une
structure arbitraire : il sert à filtrer, et un filtre sur un objet imbriqué
n'aurait pas de sens dans le langage d'expressions.

```json
{ "value": "cocody", "label": "Cocody", "attributes": { "region": "abidjan" } }
```

avec, dans le formulaire, `filter: "region = ${region}"`. Le filtrage a lieu
**sur l'appareil**, à partir du jeu déjà téléchargé : demander au serveur
reviendrait à exiger du réseau pour dérouler une question, ce qui est exclu.

## 6. Validation des soumissions

Jusqu'ici, une réponse à une question alimentée par un jeu de données n'était
pas vérifiée : le référentiel n'est pas dans le document, et `packages/shared`
ne connaît que le document.

Le serveur, lui, a les deux. `validerSoumission` accepte donc les valeurs
autorisées des jeux référencés, et vérifie ce qu'il peut vérifier :

- côté **appareil**, l'appel se fait sans ces valeurs — le contrôle est fait par
  l'interface, qui ne propose que des options existantes ;
- côté **serveur**, elles sont chargées et transmises.

Une valeur inconnue produit une violation, jamais un rejet : la soumission est
enregistrée avec sa violation, comme toute autre (`formulaires.md` §8). Un
référentiel mis à jour entre la collecte et la réception rendrait sinon
invalides des données parfaitement légitimes.

**Une valeur retirée reste acceptée.** L'agent l'a choisie alors qu'elle
existait ; la refuser lui reprocherait le temps qui passe.

## 7. Limites

| Limite | Valeur | Raison |
|---|---|---|
| entrées par jeu | 50 000 | au-delà, le téléphone d'entrée de gamme peine à filtrer |
| longueur d'une valeur | 200 | elle finit en colonne d'export |
| attributs par entrée | 20 | un référentiel n'est pas une base de données |
| taille d'un import | 10 Mo | |

## 8. API

```
POST   /datasets                    créer un jeu
GET    /datasets                    lister, avec versions et volumétrie
POST   /datasets/:id/import         remplacer le contenu, incrémenter la version
GET    /datasets/:id/entries        consulter, paginé
GET    /sync/bundle                 descente différentielle, avec les formulaires
```

## 9. Tests

- Un import qui ne change rien n'incrémente pas la version.
- Une entrée retirée puis réintroduite reprend la même ligne.
- Le delta d'un appareil à jour est vide ; celui d'un appareil très en retard
  bascule en envoi intégral.
- Une entrée retirée reste lisible pour interpréter les soumissions anciennes.
- Une soumission portant une valeur inconnue est enregistrée avec une violation,
  pas rejetée.
- Une soumission portant une valeur retirée est acceptée sans violation.
- Isolation : un jeu de données n'est jamais visible d'une autre organisation.
