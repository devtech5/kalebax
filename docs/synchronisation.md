# Spécification — Protocole de synchronisation

Module le plus exposé du produit. Une soumission perdue est une visite de
terrain à refaire, parfois impossible : la boutique a fermé, l'enquêté est
parti, la journée est facturée. Tout ce qui suit part de là.

## 1. Objectif

- **Le réseau est un détail, jamais une condition.** L'agent collecte sans
  savoir s'il a du réseau, et sans y penser.
- **Aucune donnée n'est perdue, jamais.** Ni par coupure, ni par extinction de
  l'appareil, ni par rejeu, ni par erreur serveur.
- **Aucun doublon.** Rejouer une synchronisation interrompue est le cas normal,
  pas l'exception.
- **Économe en données mobiles.** L'agent paie souvent son forfait.

## 2. Hors périmètre

- Le format d'une soumission et sa validation : `formulaires.md` §8, déjà
  implémenté.
- L'affectation par mission, zone et quota : session dédiée. Le paquet
  descendant (§7) prévoit sa place sans la définir.
- Le stockage objet des médias côté serveur : session dédiée.
- La synchronisation du poste de saisie desktop : mêmes règles, adaptateur de
  stockage différent (`packages/storage`).

## 3. Les contraintes qui décident de tout

| Contrainte | Ce qu'elle impose |
|---|---|
| Réseau 2G intermittent, coupures en plein transfert | lots courts, reprise à l'octet près sur les médias |
| Latence de plusieurs secondes | grouper les soumissions, ne pas faire un appel par unité |
| Données mobiles payées par l'agent | compression obligatoire, médias sur wifi par défaut |
| Batterie limitée | pas de sondage permanent, synchronisation déclenchée |
| Stockage limité, photos volumineuses | redimensionnement à la capture, purge après confirmation |
| Appareil éteint en plein envoi | aucun état intermédiaire non repris au démarrage |

**Le plus gros levier d'économie n'est pas dans le protocole : c'est le
redimensionnement des photos à la capture.** Une photo de téléphone fait 4 Mo,
la même en 1600 px de large et qualité 80 en fait 300. Le facteur est de
treize, aucune astuce de transport n'en approche. Le paramètre est réglable par
organisation — un audit de linéaire peut exiger la haute résolution — mais son
défaut est le redimensionnement.

## 4. États d'une soumission sur l'appareil

```
brouillon ──finaliser──> en_attente ──envoi──> envoyee ──accusé──> confirmee
                                                   │                    │
                                                   │              medias_en_attente
                                                   │                    │
                                                   └──4xx──> echec_permanent
```

| État | Signification |
|---|---|
| `brouillon` | saisie en cours, modifiable, **jamais synchronisé** |
| `en_attente` | finalisée, en file d'envoi, plus modifiable |
| `envoyee` | partie sur le réseau, accusé de réception non reçu |
| `confirmee` | le serveur a répondu avec son identifiant |
| `medias_en_attente` | texte confirmé, pièces jointes encore à monter |
| `echec_permanent` | refus non transitoire, signalé à l'agent |

**Un brouillon n'est jamais synchronisé.** Le faire supposerait de résoudre des
conflits entre appareils pour un cas rare — un agent qui commence une visite sur
un téléphone et la termine sur un autre — au prix d'une complexité qui met en
danger le cas courant.

**Une soumission finalisée n'est plus modifiable sur l'appareil**, même avant
envoi. Toute correction passe par la console d'un superviseur, qui crée une
révision attribuée. Sans cette règle, une correction locale et une correction
serveur se contrediraient, et il faudrait arbitrer.

**Rien n'est supprimé avant confirmation.** Ni au manque de place, ni à la
déconnexion, ni à la mise à jour de l'application.

## 5. Sens montant — les soumissions

### 5.1 Lots

Les soumissions partent par lots, bornés par **deux** limites :

| Limite | Valeur | Raison |
|---|---|---|
| nombre de soumissions | 25 | garder la réponse lisible et le traitement borné |
| taille du corps compressé | 512 Ko | tenir dans une fenêtre de connectivité de quelques secondes en 2G |

Un lot trop gros ne passe jamais sur un réseau qui coupe toutes les vingt
secondes ; un lot d'une seule soumission gaspille la latence, qui domine tout le
reste sur ces réseaux.

### 5.2 Le serveur ne fait pas tout ou rien

**Chaque élément du lot a son propre résultat.** Un lot partiellement traité est
un succès partiel, pas un échec.

```json
{
  "resultats": [
    { "id": "uuid-1", "etat": "recue",   "status": "received" },
    { "id": "uuid-2", "etat": "deja",    "status": "received" },
    { "id": "uuid-3", "etat": "recue",   "status": "rejected", "violations": [] },
    { "id": "uuid-4", "etat": "refusee", "code": "version-inconnue" }
  ]
}
```

L'appareil marque comme confirmées celles qui ont réussi et laisse les autres en
file. Un tout-ou-rien ferait rejouer indéfiniment un lot entier à cause d'une
seule soumission problématique — et cette soumission-là, précisément, est celle
qu'il ne faut pas perdre.

`status: rejected` n'est **pas** un refus : la donnée est enregistrée avec ses
violations pour arbitrage humain (`formulaires.md` §8). L'appareil la traite
comme confirmée.

### 5.3 Le cas qui justifie l'idempotence

L'appareil envoie un lot, le serveur l'enregistre, la réponse se perd dans la
coupure. L'appareil ne sait pas si c'est passé. **Il rejoue.** L'identifiant
généré côté client fait que le serveur reconnaît chaque soumission et répond
`deja` sans rien modifier.

C'est le scénario normal sur ces réseaux, pas un cas limite. Il est déjà
implémenté et testé côté serveur.

### 5.4 Ordre

Premier arrivé, premier envoyé. Une soumission en `echec_permanent` sort de la
file active et ne bloque pas celles qui suivent, mais reste sur l'appareil et
visible par l'agent.

## 6. Sens montant — les médias

### 6.1 Le texte d'abord, toujours

Une soumission est acceptée sans ses pièces jointes. Le texte fait quelques
kilo-octets et passe sur un réseau dégradé ; les photos suivent quand elles
peuvent. C'est déjà le modèle de données : `Attachment` est créé à la réception
avec `uploadedAt` nul.

### 6.2 Envoi par morceaux, avec reprise

Une photo de 300 Ko sur un réseau à 20 Ko/s prend quinze secondes. Une coupure à
la quatorzième ne doit pas tout reprendre.

| Seuil | Traitement |
|---|---|
| fichier ≤ 256 Ko | envoi en une fois |
| fichier > 256 Ko | morceaux de 256 Ko, reprise à l'octet près |

L'appareil annonce le fichier, le serveur répond **combien d'octets il a déjà
reçus** — zéro si c'est un premier envoi. L'appareil reprend à cet offset. Le
serveur est la source de vérité sur ce qu'il possède : un compteur local
divergerait au premier redémarrage brutal.

À la fin, le serveur vérifie le **SHA-256** annoncé. S'il ne correspond pas, le
fichier est jeté et l'envoi recommence — un média corrompu vaut moins que pas de
média, car il fait croire à une preuve.

### 6.3 Wifi par défaut

Les médias ne partent **pas** en données mobiles, sauf réglage contraire de
l'agent ou de son organisation. Le texte, lui, part toujours : il coûte quelques
kilo-octets et c'est la donnée qui compte.

L'agent doit pouvoir forcer l'envoi immédiat, y compris en données mobiles :
c'est parfois un chef de terrain qui veut ses photos avant la fin de la journée.

## 7. Sens descendant — le paquet de mission

L'application télécharge avant de partir : formulaires publiés, jeux de données,
et — plus tard — missions et quotas.

### 7.1 Différentiel obligatoire

Un référentiel de 4 000 points de vente pèse plusieurs centaines de kilo-octets.
Le retélécharger à chaque synchronisation est inacceptable.

Chaque ressource porte une version. L'appareil envoie ce qu'il détient, le
serveur renvoie **seulement ce qui a changé** :

```
GET /sync/bundle?projet=uuid&formulaires=v3,v7&datasets=points_vente:12,localites:4
```

Le serveur répond par les ajouts, modifications et suppressions depuis ces
versions. Si l'écart est trop grand — l'appareil revient après six semaines — il
renvoie la ressource entière plutôt qu'un delta plus lourd que l'original.

### 7.2 Les versions de formulaire ne se remplacent pas

Une nouvelle version publiée ne supprime pas l'ancienne sur l'appareil : les
soumissions commencées dessus doivent rester envoyables. L'ancienne version est
purgée quand plus aucune soumission locale ne la référence.

## 8. Réessai

| Situation | Traitement |
|---|---|
| réseau absent, délai dépassé, 5xx | réessai, l'élément reste en file |
| 401 jeton expiré | rafraîchir puis réessayer une fois |
| 401 après rafraîchissement | session perdue, l'agent doit se reconnecter ; **rien n'est effacé** |
| 403 organisation suspendue | file gelée, message explicite |
| 400 version de formulaire inconnue | `echec_permanent`, signalé, conservé |
| 409, 422 | ne devrait pas arriver : la réception enregistre tout |

Attente entre deux tentatives : 5 s, 15 s, 1 min, 5 min, 15 min, puis toutes les
heures. Avec **une variation aléatoire de ±20 %** — sans elle, cinquante agents
qui retrouvent le réseau au même moment à la fin d'une réunion frappent le
serveur en même temps.

**Le jeton d'accès vit quinze minutes ; une synchronisation longue l'épuise.**
L'appareil le rafraîchit avant un lot s'il expire dans moins de deux minutes,
plutôt que d'attendre le 401 et de perdre un aller-retour.

### Ne pas croire l'état du système

Un appareil peut être « connecté » à un portail wifi captif sans accès à
internet. L'état réseau du système est une indication, jamais une preuve : la
seule vérité est une requête qui aboutit.

## 9. Économie de données

- **Compression obligatoire** des corps de plus d'un kilo-octet. Un lot de
  soumissions est du JSON très répétitif : il compresse d'un facteur cinq à dix.
- **Pas de renvoi du document de formulaire** dans une soumission : seul
  `formVersionId` circule.
- **Pas de sondage.** La synchronisation se déclenche au retour du réseau, à
  l'ouverture de l'application, à la finalisation d'une soumission, et sur
  demande de l'agent.

## 10. Stockage local, chiffrement et purge

Les soumissions et les médias sont **chiffrés au repos** sur l'appareil. Un
téléphone de terrain se perd et se vole, et il contient des données personnelles
d'enquêtés.

Purge, une fois la confirmation reçue :

| Donnée | Conservation locale |
|---|---|
| médias montés | supprimés immédiatement — ils occupent presque toute la place |
| soumissions confirmées | 7 jours, réglable, pour que l'agent puisse relire son travail |
| versions de formulaire | tant qu'une soumission locale les référence |

L'agent voit ce qu'il a envoyé récemment : effacer aussitôt donne l'impression
que le travail a disparu.

## 11. Conflits

**Il n'y en a presque pas, et c'est un choix de conception.** Une soumission est
créée par un seul appareil, avec un identifiant unique, et n'est plus modifiable
localement une fois finalisée. Les jeux de données sont en lecture seule côté
agent. Les brouillons ne circulent pas.

Reste un seul cas : un superviseur corrige depuis la console une soumission déjà
envoyée. L'appareil, en la relisant, prend la version serveur — elle porte une
révision supérieure, attribuée et horodatée. L'agent ne perd rien : sa version
d'origine est la révision 1, conservée pour toujours.

## 12. Ce que l'agent voit

Sans cela, il ne fait pas confiance au produit et note tout en double sur un
cahier.

- Un compteur permanent : **en attente / envoyées**, et la taille restante.
- L'état de chaque soumission dans sa liste.
- La date et l'heure de la dernière synchronisation réussie.
- Un bouton « synchroniser maintenant », toujours accessible.
- Un message explicite en cas d'échec permanent, avec ce qu'il doit faire.

Ce dernier point vient de l'analyse de SIGNALE : l'application y propose une
synchronisation mais rien ne distingue, dans la liste, ce qui est parti de ce
qui attend.

## 13. API

```
POST /sync/submissions              lot montant, résultat par élément
POST /sync/attachments/:id/init     annonce un média, rend l'offset déjà reçu
PUT  /sync/attachments/:id/chunk    envoie un morceau à un offset
POST /sync/attachments/:id/complete vérifie le SHA-256 et scelle
GET  /sync/bundle                   descendant différentiel
GET  /sync/etat                     ce que le serveur pense détenir de cet appareil
```

`GET /sync/etat` sert au diagnostic de terrain : quand un agent affirme avoir
tout envoyé et que le superviseur ne voit rien, il faut pouvoir trancher depuis
l'appareil, sans accès à la base.

Toutes ces routes sont filtrées par `organizationId` issu du jeton. Un membre
révoqué conserve l'accès aux routes **montantes** — il doit pouvoir envoyer ce
qu'il a déjà collecté — et perd l'accès au paquet descendant
(`authentification.md` §1).

## 14. Tests

L'intégrité des données est la priorité absolue du projet. Ce module se teste
comme tel.

- **Coupure à chaque étape** : avant l'envoi, pendant, après réception mais
  avant la réponse, pendant l'envoi d'un média. Aucune donnée perdue, aucun
  doublon.
- **Rejeu** : le même lot envoyé dix fois produit une ligne par soumission.
- **Lot partiel** : un élément refusé n'empêche pas les autres d'être confirmés.
- **Reprise de média** : un envoi coupé à 60 % reprend à 60 %, et le SHA-256
  final correspond.
- **Média corrompu** : un checksum qui ne correspond pas fait recommencer, et ne
  scelle jamais un fichier abîmé.
- **Extinction brutale** à chaque état : au redémarrage, la file est cohérente
  et rien n'est en état intermédiaire irrécupérable.
- **Horloge déréglée** : une soumission datée de 2019 ou de 2031 remonte
  normalement et conserve son écart.
- **Membre révoqué** : ses soumissions en attente partent, le paquet descendant
  lui est refusé.
- **Stockage saturé** : la collecte s'arrête proprement avec un message, aucune
  donnée existante n'est supprimée pour faire de la place.
- **Isolation** : un appareil ne reçoit jamais un formulaire ni une donnée d'une
  autre organisation.
