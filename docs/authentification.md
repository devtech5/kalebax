# Spécification — Authentification et multi-tenant

Authentification 100 % maison, conformément à CLAUDE.md : aucune dépendance à un
fournisseur d'identité étranger pour une fonction cœur.

Deux populations aux contraintes opposées vivent dans le même produit.

| | Concepteur, superviseur | Agent de terrain |
|---|---|---|
| Support | navigateur, poste desktop | téléphone Android d'entrée de gamme |
| Identifiant | adresse email | numéro de téléphone |
| Preuve | mot de passe | code à usage unique par SMS ou WhatsApp |
| Réseau | présent | absent plusieurs jours |
| Enjeu | droits étendus sur les données | ne jamais être bloqué en pleine collecte |

## 1. La décision centrale : session locale ≠ jeton d'API

CLAUDE.md demande qu'un agent puisse travailler « plusieurs jours sans contact
serveur ». La lecture naïve serait d'émettre un jeton d'accès valable sept
jours. **C'est le mauvais outil** : un JWT de sept jours ne peut pas être révoqué,
et un téléphone volé donne une semaine d'accès à l'API sur des données
personnelles.

Le besoin réel n'est pas d'appeler l'API pendant sept jours : c'est d'**ouvrir
l'application et de collecter** sans réseau. La collecte hors ligne n'appelle
aucune API — elle écrit dans SQLite. Deux notions distinctes, donc :

- **La session locale** autorise l'ouverture de l'application et la collecte.
  Elle est vérifiée par l'appareil, contre un état stocké localement. Durée par
  défaut : **7 jours** sans contact serveur, prolongée à chaque synchronisation
  réussie. C'est un paramètre d'organisation, relevable jusqu'à 30 jours pour
  les missions longues en zone blanche.
- **Le jeton d'accès** sert à appeler l'API. Durée : **15 minutes**. Il n'existe
  que pendant une synchronisation.
- **Le jeton de rafraîchissement** est stocké sur l'appareil, à rotation à
  chaque usage, révocable côté serveur. Durée : 60 jours.

L'agent en zone blanche n'a aucun jeton d'accès valide pendant six jours, et cela
n'a aucune importance : il ne parle à personne.

### Révocation et dernière synchronisation

Un agent dont l'accès est révoqué — fin de contrat, appareil perdu — ne doit pas
emporter les données déjà collectées dans la tombe. **La révocation interdit
toute nouvelle collecte mais autorise une dernière synchronisation montante.**

Le serveur accepte donc les soumissions présentées avec un jeton de
rafraîchissement révoqué, les enregistre en signalant la révocation dans le
journal d'audit, et ne délivre en retour ni formulaire, ni mission, ni jeu de
données. L'application efface ensuite sa base locale.

Perdre une semaine de collecte de terrain parce qu'un compte a été fermé le
lundi serait une faute produit. Le vol de données, lui, est traité par le
chiffrement au repos et l'effacement à distance, pas en jetant la donnée.

## 2. Modèle de données

### User

```
id                uuid (PK)
email             string (nullable, unique) — concepteurs et superviseurs
phone             string (nullable, unique) — agents, format E.164
passwordHash      string (nullable) — Argon2id
fullName          string
preferredLanguage string — langue de l'interface, distincte de celle des formulaires
status            enum UserStatus (active, suspended, deleted)
lastSeenAt        timestamp (nullable)
createdAt         timestamp
```

Contrainte : `email` ou `phone` renseigné, jamais aucun des deux. Un même
individu peut avoir les deux — un chef de terrain collecte et conçoit.

**`User` ne porte pas d'`organizationId`.** C'est la seule table dans ce cas, et
c'est délibéré : un enquêteur travaille couramment pour deux agences
concurrentes. Le rattachement vit dans `Membership`.

### Organization

```
id                uuid (PK)
name              string
slug              string (unique)
country           string — ISO 3166-1 alpha-2, pilote la loi applicable
dataRegion        string — emplacement d'hébergement communicable au client
offlineGraceDays  int — durée de session locale, 7 par défaut
status            enum (active, readonly, suspended)
createdAt         timestamp
```

`status: readonly` est l'état d'un abonnement expiré : consultation et export
restent possibles, la collecte s'arrête. **Aucune donnée n'est supprimée.**

### Membership

```
id                uuid (PK)
userId            uuid (FK)
organizationId    uuid (FK)
role              enum Role (owner, admin, designer, supervisor, agent)
status            enum (active, revoked)
revokedAt         timestamp (nullable)
createdAt         timestamp
```

Unicité : `(userId, organizationId)`.

| Rôle | Droits |
|---|---|
| `owner` | tout, y compris facturation et suppression de l'organisation |
| `admin` | membres, projets, exports massifs |
| `designer` | conception et publication de formulaires |
| `supervisor` | suivi, correction de soumissions, validation, export de ses projets |
| `agent` | collecte sur les missions qui lui sont affectées |

Un `agent` ne lit jamais les soumissions d'un autre agent.

### RefreshToken

```
id                uuid (PK)
userId            uuid (FK)
organizationId    uuid (FK) — l'organisation active de cette session
tokenHash         string — SHA-256 ; le jeton en clair n'existe que sur l'appareil
deviceId          string (nullable)
deviceLabel       string (nullable) — « Tecno Spark 8, Awa »
expiresAt         timestamp
revokedAt         timestamp (nullable)
replacedById      uuid (nullable, FK) — chaînage de rotation
lastUsedAt        timestamp (nullable)
createdAt         timestamp
```

**Rotation à chaque usage.** Si un jeton déjà remplacé est réutilisé, c'est qu'il
a été copié : toute la chaîne est révoquée et l'événement est journalisé.

### OtpChallenge

```
id                uuid (PK)
phone             string
codeHash          string — Argon2id ; un code à six chiffres est un secret
channel           enum (sms, whatsapp)
purpose           enum (login, enrollment)
attempts          int
expiresAt         timestamp — création + 5 minutes
consumedAt        timestamp (nullable)
createdAt         timestamp
```

## 3. Parcours

### Concepteur — email et mot de passe

1. `POST /auth/login` avec email et mot de passe.
2. Vérification Argon2id. **La réponse est identique que le compte existe ou
   non**, et le temps de réponse aussi : une vérification factice est exécutée
   quand l'utilisateur est inconnu, sans quoi l'écart de latence révèle
   l'existence du compte.
3. Si l'utilisateur appartient à plusieurs organisations, la réponse liste ses
   appartenances et n'émet aucun jeton tant qu'une organisation n'est pas
   choisie.
4. Émission du couple accès + rafraîchissement.

Mot de passe : 10 caractères minimum, aucune règle de composition imposée — les
règles de composition produisent des mots de passe prévisibles et notés sur un
papier collé à l'écran. Les mots de passe les plus courants sont refusés par
liste.

### Agent — téléphone et code à usage unique

1. `POST /auth/otp/request` avec le numéro. Réponse toujours identique, qu'un
   compte existe ou non.
2. Code à six chiffres, valable 5 minutes, envoyé par WhatsApp avec repli SMS.
3. `POST /auth/otp/verify`. Trois tentatives, puis le défi est brûlé.
4. Émission des jetons, et de la durée de session locale de l'organisation.

**Limitation de débit**, indispensable : un SMS coûte de l'argent, et une boucle
de demandes est autant un vol qu'un déni de service.

| Portée | Limite |
|---|---|
| par numéro | 3 demandes par heure, 10 par jour |
| par IP | 20 demandes par heure |
| vérifications par défi | 3 |

### Rafraîchissement

`POST /auth/refresh`. Le jeton présenté est révoqué et remplacé dans la même
transaction. Un jeton déjà remplacé déclenche la révocation de toute la chaîne.

## 4. Jetons

Le jeton d'accès est un JWT signé en **EdDSA (Ed25519)**, pas RS256 : clés
courtes, signature rapide, pas de paramétrage qui puisse être mal choisi. Les
clés tournent, l'en-tête porte un `kid`.

```json
{
  "sub": "uuid utilisateur",
  "org": "uuid organisation",
  "role": "agent",
  "sid": "uuid du refresh token",
  "iat": 1786000000,
  "exp": 1786000900
}
```

`alg: none` et la substitution d'algorithme sont refusées explicitement : la
vérification impose EdDSA, elle ne lit pas l'en-tête pour choisir.

**`organizationId` vient toujours du jeton, jamais du corps de la requête ni
d'un paramètre d'URL.** C'est la règle qui tient tout le multi-tenant : elle est
appliquée par un garde global, et une route qui accepterait un `organizationId`
en entrée est un défaut de conception, pas une commodité.

## 5. Isolation multi-tenant

Trois couches, parce qu'une seule finit toujours par être contournée un jour de
hâte :

1. **Le garde** peuple un contexte de requête avec l'organisation du jeton.
2. **La couche d'accès aux données** injecte `organizationId` dans tout `where`
   et dans tout `create`. Aucun service métier ne construit un filtre
   d'organisation à la main.
3. **Les tests** vérifient qu'aucune route n'expose une donnée d'une autre
   organisation, y compris par identifiant deviné — un `GET` sur l'UUID exact
   d'une soumission d'un autre client doit rendre 404, jamais 403 : un 403
   confirmerait l'existence de la ressource.

## 6. Ce qui est journalisé

Au journal d'audit : connexion réussie et échouée, demande et vérification
d'OTP, rotation et révocation de jeton, réutilisation d'un jeton révoqué,
changement de rôle, suspension de compte, synchronisation par un membre révoqué.

Le journal ne contient **jamais** de mot de passe, de code OTP, de jeton, ni de
condensat de ces éléments.

## 7. Ce qui est hors périmètre

- Fédération d'identité (SSO, OAuth) : contraire à la souveraineté, et aucun
  client cible ne le demande.
- Second facteur pour les concepteurs : à prévoir, mais après la boucle
  complète.
- Réinitialisation de mot de passe par email : nécessite un service d'envoi, à
  spécifier avec les notifications.

## 8. Tests

- Isolation : aucune route n'expose une donnée d'une autre organisation.
- Un `organizationId` fourni dans le corps d'une requête est ignoré.
- Rotation : un jeton de rafraîchissement ne sert qu'une fois ; sa réutilisation
  révoque la chaîne entière.
- Énumération : réponses et latences identiques pour un compte connu et inconnu.
- Limitation de débit sur les demandes d'OTP.
- Un membre révoqué peut effectuer une dernière synchronisation montante, et ne
  reçoit ni formulaire ni mission en retour.
- Un jeton `alg: none` ou signé avec un autre algorithme est refusé.
- Un agent ne lit pas les soumissions d'un autre agent.
