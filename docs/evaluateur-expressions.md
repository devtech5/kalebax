# Spécification — Évaluateur d'expressions

Complément de `formulaires.md` §6. Ce document fixe la **sémantique exacte** du
mini-langage : grammaire, précédence, types, conversions, valeurs manquantes,
comportement de chaque fonction sur entrée invalide.

Il existe pour une seule raison : l'évaluateur tourne sur le téléphone, sur le
poste desktop et sur le serveur. Une divergence d'un seul cas — un `null` traité
différemment, une division par zéro qui remonte une erreur d'un côté et un vide
de l'autre — produit un formulaire qui valide chez l'agent et se fait rejeter au
serveur. L'agent est à 300 km, il ne peut rien y faire, et la donnée est perdue.
Tout ce qui suit est donc décidé une fois, écrit une fois, testé une fois.

## 1. Où le langage est utilisé

| Attribut | Type de retour attendu | Évalué quand |
|---|---|---|
| `relevant` | booléen | à chaque changement d'une dépendance |
| `constraint` | booléen | à la saisie d'une valeur, puis à la réception |
| `required` | booléen | à la validation |
| `default` | selon le type de la question | à l'entrée dans la question |
| `repeatCount` | entier | à l'entrée dans le groupe répétable |
| `calculate` | selon le type déclaré | à chaque changement d'une dépendance |
| `filter` (cascade) | booléen | au filtrage d'une liste d'options |

## 2. Types de valeurs

L'évaluateur manipule cinq types et rien d'autre.

| Type | Provenance | Notes |
|---|---|---|
| `null` | question non répondue, non pertinente, ou erreur d'exécution | |
| `boolean` | comparaisons, `and`/`or`, littéraux `true`/`false` | |
| `number` | `integer`, `decimal`, littéraux numériques | flottant IEEE 754 |
| `string` | `text`, `select_one`, `barcode`, dates ISO 8601 | |
| `array` | `select_multiple`, `rank`, questions média, agrégats de `repeat` | |

**Les dates ne sont pas un type distinct.** Une date est une chaîne ISO 8601
(`2026-08-13`, `2026-08-13T03:24:00.000Z`). Les fonctions de date la lisent et la
valident. Ce choix évite un type de plus et colle exactement à ce qui est stocké
dans `data`.

**Les montants sont des `number` entiers.** L'évaluateur ne connaît pas la
monnaie ; c'est le type de question `integer` qui garantit l'absence de décimale,
et la validation à la réception qui la vérifie. Une expression qui divise un
montant produit un flottant : c'est au concepteur d'entourer d'un `round()` ou
d'un `int()`.

## 3. Grammaire

### 3.1 Éléments

```
${nom_question}      référence à une réponse
.                    valeur de la question courante (constraint et default seuls)
123      -4.5        nombres
'texte'              chaîne, guillemets simples uniquement
true  false  null    littéraux
( )                  groupement
nom(a, b)            appel de fonction
```

Une chaîne s'écrit entre guillemets simples. Le guillemet simple s'échappe en le
doublant : `'l''agent'`. Il n'existe aucun autre échappement — pas de `\n`, pas de
`\t`. Un libellé multiligne n'a rien à faire dans une expression.

**Conséquence utile : la barre oblique inverse est transmise telle quelle.** Un
motif d'expression régulière s'écrit donc naturellement, `'^\d{4}$'`, sans le
doublement des barres qu'imposent la plupart des langages.

Les identifiants de question respectent `[a-z_][a-z0-9_]*` (`formulaires.md`
§5.2). Les noms de fonction peuvent contenir un tiret : `count-selected`.

### 3.2 Précédence

Du plus fort au plus faible. Tous les opérateurs binaires sont associatifs à
gauche.

| Rang | Opérateurs |
|---|---|
| 1 | `( )`, appel de fonction, `${...}`, `.`, littéraux |
| 2 | `-` unaire |
| 3 | `*`, `/`, `mod` |
| 4 | `+`, `-` |
| 5 | `<`, `<=`, `>`, `>=` |
| 6 | `=`, `!=` |
| 7 | `and` |
| 8 | `or` |

`not` **n'est pas un opérateur** mais une fonction : `not(${a} = 'oui')`. Cela
supprime toute ambiguïté de précédence entre la négation et les comparaisons, qui
est une source classique d'erreurs silencieuses.

`=` est l'égalité, pas une affectation. Il n'existe ni `==` ni `!==` — les écrire
est une erreur de syntaxe signalée à la publication, avec un message qui propose
la forme correcte.

### 3.3 Références dans les groupes répétables

À l'intérieur d'un `repeat`, `${prix}` désigne la valeur de l'**occurrence
courante**. Si le nom n'existe pas dans l'occurrence, la résolution remonte au
niveau parent, puis à la racine. La première correspondance gagne.

Depuis l'extérieur du `repeat`, la notation pointée désigne le tableau de toutes
les occurrences :

```
sum(${produits.prix})        total de la colonne prix sur toutes les occurrences
count(${produits})           nombre d'occurrences
```

`position()` donne le rang de l'occurrence courante, à partir de 1. Hors d'un
`repeat`, elle vaut `null`.

## 4. Valeurs manquantes

C'est la partie qui décide de la cohérence entre le téléphone et le serveur.
Toutes les règles ci-dessous sont normatives.

### 4.1 Ce qui vaut `null`

Une question jamais répondue, une question rendue non pertinente par son
`relevant`, une occurrence de `repeat` inexistante, une référence à un nom absent
du formulaire (impossible en pratique : bloqué à la publication), et le résultat
de toute opération invalide.

Une chaîne vide `''` n'est **pas** `null`. Un tableau vide `[]` n'est pas `null`
non plus. `count()` d'un tableau vide vaut `0`.

### 4.2 Propagation

**Arithmétique** — toute opération dont un opérande est `null` donne `null`.
`null + 5` vaut `null`, jamais `5`.

**Comparaisons d'ordre** (`<`, `<=`, `>`, `>=`) — un opérande `null` donne
`null`. Une question vide n'est ni plus grande ni plus petite que quoi que ce
soit.

**Égalité** (`=`, `!=`) — `null` est comparable. `null = null` vaut `true`,
`null = 'oui'` vaut `false`, `null != 'oui'` vaut `true`. C'est la seule
manière d'écrire « cette question n'a pas été répondue » sans fonction dédiée.

**Logique à trois valeurs**, comme en SQL :

| `a` | `b` | `a and b` | `a or b` |
|---|---|---|---|
| `true` | `true` | `true` | `true` |
| `true` | `false` | `false` | `true` |
| `true` | `null` | `null` | `true` |
| `false` | `false` | `false` | `false` |
| `false` | `null` | `false` | `null` |
| `null` | `null` | `null` | `null` |

Autrement dit : `false and inconnu` vaut `false` (on sait déjà que c'est faux),
mais `true and inconnu` reste `inconnu`.

### 4.3 Réduction finale en booléen — la règle qui protège l'agent

Les attributs qui attendent un booléen peuvent recevoir `null`. Chacun le résout
dans le sens qui **ne bloque jamais la personne qui collecte** :

| Attribut | `null` devient | Raison |
|---|---|---|
| `relevant` | `false` | on n'affiche pas une question dont la condition n'est pas établie |
| `constraint` | `true` | on n'interdit jamais une saisie sur une contrainte indécidable |
| `required` | `false` | on n'exige jamais une réponse sur une condition indécidable |
| `filter` | `false` | une option dont l'appartenance est indécidable ne s'affiche pas |

L'asymétrie entre `relevant` et `constraint` est volontaire et doit être testée
explicitement. Elle traduit une règle produit : une contrainte qu'on ne sait pas
évaluer ne doit jamais empêcher une donnée d'être collectée.

## 5. Conversions

L'évaluateur **ne convertit pas implicitement** entre chaînes et nombres.
`'12' + 3` vaut `null`, pas `15` et pas `'123'`. Cette rigueur est délibérée :
les conversions implicites de JavaScript sont la première source de divergence
entre deux implémentations d'un même langage.

La conversion est explicite, par `number()` et `string()`.

Trois exceptions, toutes vérifiées à la publication :

1. **`+` sur deux chaînes est une erreur de publication**, pas une concaténation.
   Concaténer s'écrit `concat(a, b)`.
2. **Les comparaisons entre une valeur de question numérique et un littéral
   numérique** sont valides sans conversion : le type de la question est connu au
   moment de la publication.
3. **Les comparaisons de dates ISO 8601** entre elles fonctionnent par ordre
   lexicographique, ce qui coïncide avec l'ordre chronologique pour ce format.
   `${date_visite} < '2026-01-01'` est donc valide et correct.

## 6. Fonctions

Signature, comportement sur `null`, comportement sur entrée invalide. **Toute
entrée invalide donne `null`** — jamais une exception, jamais une valeur
approchée. L'arité et les types sont vérifiés à la publication.

### 6.1 Logique

| Fonction | Retour | Détail |
|---|---|---|
| `not(a)` | booléen | `not(null)` vaut `null` |
| `if(cond, a, b)` | selon branches | `cond` null → branche `b`. **Les deux branches sont évaluées** : le langage n'a pas d'effets de bord, donc aucune différence observable, mais le budget d'exécution compte les deux |
| `coalesce(a, b, ...)` | premier non-`null` | tous `null` → `null`. Arité ≥ 2 |

### 6.2 Sélections

| Fonction | Retour | Détail |
|---|---|---|
| `selected(champ, 'valeur')` | booléen | `true` si la valeur figure dans la sélection. Champ `null` → `false`, pas `null` : « rien n'est sélectionné » est une information certaine |
| `count-selected(champ)` | nombre | `null` → `0` |
| `count(champ)` | nombre | occurrences d'un `repeat` ou éléments d'un tableau. `null` → `0` |
| `position()` | nombre | rang dans le `repeat` courant, à partir de 1. Hors `repeat` → `null` |

`selected` et `count-selected` renvoyant une valeur certaine sur `null` est
délibéré : une case non cochée est une réponse, pas une absence de réponse.

### 6.3 Nombres

| Fonction | Retour | Détail |
|---|---|---|
| `sum(tableau)` | nombre | ignore les `null`. Tableau vide → `0` |
| `min(tableau)` / `max(tableau)` | nombre | ignorent les `null`. Tableau vide ou tout `null` → `null` |
| `round(x, n?)` | nombre | `n` décimales, `0` par défaut. Arrondi **au plus proche, moitié vers le haut** (`round(2.5)` = `3`, `round(-2.5)` = `-2`). Fixé explicitement : les langages divergent sur ce point |
| `int(x)` | nombre | troncature **vers zéro** (`int(-2.7)` = `-2`), pas un arrondi |
| `number(x)` | nombre | chaîne numérique → nombre. Chaîne non numérique → `null`. Booléen → `1` / `0` |
| `string(x)` | chaîne | nombre → notation décimale sans exposant |

`sum` ignore les `null` alors que `+` les propage. L'incohérence est apparente :
`+` porte sur deux valeurs dont l'absence de l'une rend le total faux, tandis que
`sum` agrège une colonne de `repeat` où les occurrences non remplies sont
normales.

**Division par zéro** — `x / 0` vaut `null`. Pas `Infinity`, pas une erreur. Idem
pour `mod 0`. `Infinity` et `NaN` n'existent pas dans le langage : toute
opération qui les produirait donne `null`.

`mod` suit le signe du **dividende** : `-7 mod 3` vaut `-1`. Fixé explicitement,
les langages divergent aussi là-dessus.

### 6.4 Chaînes

| Fonction | Retour | Détail |
|---|---|---|
| `string-length(s)` | nombre | en **points de code Unicode**, pas en unités UTF-16. « é » compte pour 1, un emoji aussi. `null` → `0` |
| `substr(s, début, fin?)` | chaîne | indices à partir de `0`, `fin` exclue, en points de code. Indices hors bornes → tronqué sans erreur. `null` → `null` |
| `concat(a, b, ...)` | chaîne | les `null` comptent pour `''`. Les nombres sont convertis |
| `regex(s, motif)` | booléen | correspondance **partielle** ; ancrer avec `^` et `$` pour une correspondance totale. `s` null → `false` |

`string-length` en points de code est une décision de terrain : les libellés et
les réponses sont en français et dans des langues à diacritiques, et une
contrainte de longueur qui compte « é » pour deux caractères est un bogue
incompréhensible pour le concepteur.

**Restrictions sur `regex`** — le motif est un littéral, jamais une expression
calculée : un motif construit à l'exécution ne peut pas être vérifié à la
publication. Il est limité à 200 caractères. Trois formes sont **refusées à la
publication**, parce qu'elles provoquent une explosion combinatoire du moteur
d'expressions régulières et figeraient le téléphone d'un agent en pleine
collecte :

- les références arrière — `(a)\1` ;
- un quantificateur appliqué à un groupe qui en contient déjà un — `(a+)+` ;
- une alternance à l'intérieur d'un groupe quantifié — `(a|a)*`.

Une alternance **non répétée** reste évidemment autorisée : `^(abidjan|bouake)$`
est le cas courant et ne présente aucun risque.

Le moteur est celui de la plateforme, sans drapeau autre que `u`.

### 6.5 Dates

| Fonction | Retour | Détail |
|---|---|---|
| `today()` | chaîne `AAAA-MM-JJ` | figée, voir §7 |
| `now()` | chaîne ISO 8601 complète | figée, voir §7 |
| `date-diff(a, b, unité)` | nombre | `b - a` dans l'unité donnée : `'jours'`, `'mois'`, `'annees'`, `'heures'`, `'minutes'`. Résultat tronqué vers zéro. Date invalide → `null` |

Une chaîne qui n'est pas une date ISO 8601 valide donne `null`, sans tentative
d'interprétation. `'13/08/2026'` n'est pas une date pour l'évaluateur.

Les unités sont en français, sans accent, pour rester saisissables sur un clavier
de téléphone : `'annees'`, pas `'années'`.

## 7. Déterminisme

Une expression doit donner le même résultat sur le téléphone au moment de la
saisie et sur le serveur à la réception, éventuellement trois jours plus tard.
`today()` et `now()` sont donc **figées au démarrage de la saisie** et
transportées avec la soumission.

Le contexte d'évaluation porte une valeur `now` unique :

- côté client, elle est fixée à l'ouverture du formulaire et ne bouge plus,
  même si la saisie s'étale sur plusieurs heures ou reprend le lendemain ;
- côté serveur, elle est lue depuis `startedAt` de la soumission.

Toutes les évaluations d'une même saisie partagent cette valeur. Deux appels à
`now()` dans un même formulaire renvoient donc strictement la même chaîne.

Aucune autre source de non-déterminisme n'existe : pas d'aléatoire, pas d'accès
au réseau, au système de fichiers, à la position ou à l'horloge en dehors de
`now`. L'évaluateur est une fonction pure de `(expression, données, contexte)`.

## 8. Sécurité

**Aucun `eval`, aucun `new Function`, aucune construction dynamique de code.** Un
formulaire est une donnée fournie par un utilisateur, et il est évalué sur le
serveur à la réception de chaque soumission : l'exécuter serait une faille
d'exécution de code arbitraire à distance.

L'expression est analysée en un arbre syntaxique, et cet arbre est parcouru. Il
n'y a pas d'autre chemin.

### Budget d'exécution

Une expression pathologique ne doit pas figer l'application d'un agent sur un
appareil à 2 Go de RAM. Limites vérifiées **à la publication** (statiquement) et
**à l'exécution** (dynamiquement, pour les cas dépendant de la taille des
`repeat`) :

| Limite | Valeur |
|---|---|
| Longueur du texte de l'expression | 2 000 caractères |
| Profondeur de l'arbre | 32 |
| Nombre de nœuds | 500 |
| Opérations élémentaires par évaluation | 10 000 |
| Longueur d'un motif `regex` | 200 caractères |

Le dépassement à l'exécution donne `null` et inscrit une violation dans le
rapport de validation de la soumission — jamais un plantage, jamais un blocage.
Le langage n'ayant ni boucle ni fonction définie par l'utilisateur, la récursion
infinie est structurellement impossible.

**Le plafond de nœuds borne le nombre d'opérations.** Chaque nœud évalué compte
pour une opération, et une expression publiable en compte au plus 500 : le
budget d'exécution de 10 000 ne peut donc pas être atteint par une expression
qui a passé la publication. Il reste comme défense en profondeur — contre un
document de formulaire falsifié soumis directement à l'API, sans passer par la
publication — et non comme un mécanisme de tous les jours.

La profondeur est vérifiée **pendant** l'analyse et non sur l'arbre produit :
une expression de profondeur 10 000 ferait déborder la pile d'appels avant qu'on
ait pu mesurer quoi que ce soit.

## 9. Validation à la publication

Une erreur d'expression découverte par un agent à 300 km du bureau est un échec
produit. Tout ce qui peut être détecté avant la publication l'est, et **bloque**
la publication :

1. Syntaxe.
2. Fonction inconnue, arité incorrecte.
3. Référence `${...}` à une question inexistante.
4. Référence à une question définie **après** celle qui l'utilise, hors agrégat
   de `repeat` — une question ne peut dépendre d'une réponse pas encore donnée.
5. Types incompatibles, déduits du type déclaré des questions référencées.
6. **Cycle de dépendances** (§10).
7. Budget statique dépassé (longueur, profondeur, nœuds).
8. Motif `regex` à risque d'explosion combinatoire.
9. Retour incompatible avec l'attribut : un `relevant` qui ne peut pas produire
   un booléen est refusé.

Chaque erreur porte le `name` de la question, la position dans le texte de
l'expression, et un message en français destiné au concepteur — pas une trace
technique.

Les points **4** et **5** exigent la liste ordonnée des questions et leur type
déclaré : ils seront branchés en même temps que le schéma de formulaire. Les
sept autres ne dépendent que de l'expression elle-même et sont actifs.

## 10. Graphe de dépendances

Chaque expression déclare les questions qu'elle lit. L'ensemble forme un graphe
orienté qui sert à trois choses :

- **ordonner les recalculs** : quand une réponse change, seules les questions qui
  en dépendent, directement ou transitivement, sont réévaluées — sur un
  formulaire de 200 questions, tout réévaluer à chaque frappe est inutilisable
  sur un appareil d'entrée de gamme ;
- **détecter les cycles**, par tri topologique à la publication. Un cycle est
  refusé avec le chemin complet affiché : `prix → remise → total → prix` ;
- **calculer l'ordre d'évaluation initial** des `calculate` et des `default`.

Le graphe est construit une fois à la publication et sérialisé **avec** le
document de formulaire. L'application ne le recalcule pas au démarrage : sur un
gros formulaire, c'est du temps de chargement que l'agent attend, pour un
résultat qui ne peut pas avoir changé puisque la version est immuable.

## 11. Erreurs à l'exécution

Il n'y en a pas. Toute situation anormale à l'exécution produit `null` et,
lorsque le contexte le permet, une entrée dans le rapport de validation de la
soumission.

C'est une conséquence directe de la règle produit : **perdre une donnée de
terrain parce qu'une expression a échoué est pire que conserver la donnée avec sa
violation pour arbitrage humain** (`formulaires.md` §8). Un superviseur tranche
depuis la console ; l'agent, lui, n'est jamais interrompu.

La sévérité est reportée sur la publication, où le concepteur est devant son
écran, connecté, et peut corriger.

## 12. Tests — priorité absolue

Le même jeu de tests s'exécute dans `packages/shared` et est rejoué sur mobile.

**Par élément de langage** : chaque opérateur sur chaque combinaison de types, y
compris `null` ; chaque fonction sur son arité nominale, sur `null`, sur type
incorrect, sur tableau vide.

**Cas frontières nommés**, chacun un test explicite :

- `x / 0` et `x mod 0` donnent `null`
- `round(2.5)` = `3`, `round(-2.5)` = `-2`, `int(-2.7)` = `-2`
- `-7 mod 3` = `-1`
- `'12' + 3` = `null` (aucune conversion implicite)
- `null = null` = `true`, `null < 5` = `null`
- `false and null` = `false`, `true and null` = `null`
- `relevant` null masque, `constraint` null accepte
- `selected(null, 'x')` = `false`, pas `null`
- `string-length('éàü')` = `3`
- `sum` sur une colonne de `repeat` partiellement remplie ignore les vides
- deux appels à `now()` dans une même saisie donnent la même valeur

**Cas malveillants** : expression de 10 000 caractères, imbrication de profondeur
100, `regex` à quantificateurs imbriqués, agrégat sur un `repeat` de 10 000
occurrences. Aucun ne doit produire autre chose qu'un refus à la publication ou
un `null` borné à l'exécution.

**Non-régression** : chaque expression réelle rencontrée sur le terrain qui a
posé problème entre dans le jeu de tests, définitivement.

**Équivalence client/serveur** : le jeu de cas est exécuté à l'identique dans les
deux contextes d'appel, et les résultats doivent être strictement égaux. C'est le
test qui justifie l'existence de ce document.
