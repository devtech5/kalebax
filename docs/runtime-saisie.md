# Spécification — Runtime de saisie

L'état d'une saisie en cours, sans rendu. Dernier morceau de logique partagée
avant les applications : ce qui est écrit ici ne sera pas réécrit trois fois.

## 1. Objectif

Interpréter un document de formulaire et tenir l'état d'une saisie : réponses,
pertinence, calculs, contraintes, navigation, occurrences de groupes répétables.

Le module **ne rend rien**. Il ne connaît ni DOM, ni React Native, ni style. Il
répond à trois questions et à rien d'autre : que faut-il afficher, qu'est-ce qui
ne va pas, et que vaut la soumission.

## 2. Hors périmètre

- Le rendu des types de questions : `packages/ui-web` et `packages/ui-native`.
- La persistance du brouillon : `packages/storage`.
- L'envoi : `packages/sync`.
- La capture des médias et de la position : propres à chaque cible.

## 3. La décision qui compte : les réponses masquées ne sont pas perdues

Une question rendue non pertinente doit être **vide dans la soumission**
(`formulaires.md` §8, point 4). La lecture naïve est d'effacer la réponse dès
que la condition devient fausse.

C'est le drame classique de la collecte : l'agent coche « non » par erreur,
douze réponses disparaissent, il recoche « oui » — tout est à ressaisir. Sur une
visite de quarante minutes, c'est une visite perdue.

**Le runtime met donc les réponses masquées en réserve** au lieu de les
détruire. Elles restent hors des données produites, l'invariant est respecté ;
si la condition redevient vraie, elles reviennent.

La réserve vit le temps de la saisie et n'est **jamais transmise** : elle
disparaît à la finalisation. Une donnée que le formulaire déclare non pertinente
n'a pas à quitter l'appareil.

## 4. Ce que le runtime expose

| Question | Réponse |
|---|---|
| Qu'afficher ? | les éléments pertinents, dans l'ordre, groupés en pages |
| Qu'est-ce qui ne va pas ? | les violations courantes, par question |
| Que vaut la soumission ? | les données, nettoyées de la réserve |

## 5. Recalcul ciblé

Quand une réponse change, seules les questions qui en dépendent — directement ou
transitivement — sont réévaluées. Le graphe de dépendances est calculé une fois
à la publication et transporté avec le document (`evaluateur-expressions.md`
§10).

Sur un formulaire de 200 questions, tout réévaluer à chaque frappe rend la
saisie collante sur un appareil d'entrée de gamme. Ce n'est pas une optimisation
prématurée : c'est la différence entre utilisable et abandonné.

Les `calculate` sont recalculés dans l'ordre topologique, une seule fois par
changement, même quand plusieurs chemins mènent à eux.

## 6. Valeurs par défaut

Appliquées **une seule fois**, à la première apparition de la question, et
jamais ensuite. Réappliquer un défaut sur une question que l'agent a vidée
délibérément écraserait son intention — et un champ qui se remplit tout seul
après avoir été effacé est incompréhensible.

Une valeur par défaut n'est pas une réponse : une question obligatoire portant
un défaut non modifié reste à confirmer par l'agent avant finalisation.

## 7. Contraintes et obligations

Le runtime **signale, il ne bloque pas**. Il expose les violations ; l'interface
décide d'insister.

`finaliser()` rend toujours des données, accompagnées des violations restantes.
C'est cohérent avec la réception : le serveur enregistre une soumission
non conforme avec ses violations plutôt que de la perdre. Un agent bloqué par
une contrainte mal écrite à 300 km du bureau est un échec produit ; une donnée
imparfaite mais arbitrable est un moindre mal.

## 8. Pages

Un groupe de premier niveau porteur de `appearance: "field-list"` forme une
page. Les autres éléments s'enchaînent question par question, comme dans les
outils dont les agents ont l'habitude.

Une page dont tous les éléments sont masqués **est sautée** : afficher un écran
vide fait croire à un bug.

## 9. Groupes répétables

- `ajouterOccurrence` respecte `maxRepeat`, `supprimerOccurrence` respecte
  `minRepeat`.
- Un `repeatCount` piloté par une expression ajuste le nombre d'occurrences à
  chaque recalcul, **sans jamais supprimer une occurrence déjà renseignée** :
  une réponse saisie ne disparaît pas parce qu'un nombre a changé ailleurs.
- Deux niveaux d'imbrication au maximum, comme le schéma l'impose.

## 10. Instant figé

`today()` et `now()` sont fixés à l'ouverture du formulaire et transportés avec
la soumission. Le runtime les fige à sa création, sans jamais relire l'horloge
ensuite : c'est ce qui garantit que le serveur aboutira au même verdict trois
jours plus tard.

## 11. Tests

- Une réponse masquée disparaît des données, revient si la condition redevient
  vraie, et ne quitte jamais l'appareil.
- Un changement ne réévalue que les questions concernées.
- Une chaîne de calculs se propage dans le bon ordre.
- Un défaut ne se réapplique pas après effacement.
- Une page entièrement masquée est sautée, dans les deux sens.
- `maxRepeat` et `minRepeat` sont respectés ; un `repeatCount` décroissant ne
  supprime aucune occurrence renseignée.
- Les données produites sont acceptées par `validerSoumission` sans violation
  quand la saisie est complète — le runtime et le validateur ne doivent jamais
  diverger.
