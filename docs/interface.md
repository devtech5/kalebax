# Spécification — Système d'interface

Le rendu DOM des questions, partagé par la console web et le poste de saisie
desktop. C'est le seul module écrit deux fois — une fois ici en DOM, une fois en
React Native — donc tout ce qui n'est pas du pixel doit rester dans
`form-runtime`.

## 1. La tension à arbitrer

CLAUDE.md demande une interface « sobre, gros boutons, utilisable sur petit
écran et vieux matériel ». Les bibliothèques d'effets à la mode font l'inverse :
animations permanentes, dégradés animés, flou d'arrière-plan. Sur un Android
d'entrée de gamme à 2 Go, un flou en arrière-plan fait tomber le défilement à
quinze images par seconde et vide la batterie d'un agent qui a huit heures de
terrain devant lui.

**L'arbitrage est tranché : la sobriété gagne, et le soin passe par autre
chose.** Une interface professionnelle n'est pas une interface animée, c'est une
interface où l'espacement est régulier, les cibles atteignables, le contraste
suffisant en plein soleil, et où rien ne bouge sans raison.

Ce qui est retenu de l'école shadcn/ui : des primitives accessibles qu'on
possède dans son dépôt plutôt qu'une dépendance à un acteur tiers, des variantes
explicites, et des jetons de style plutôt que des valeurs en dur.

Ce qui est écarté : les effets décoratifs, les animations d'entrée sur chaque
élément, les polices distantes.

## 2. Contraintes qui décident du design

| Contrainte de terrain | Ce qu'elle impose |
|---|---|
| Saisie debout, au doigt, parfois avec des gants | cibles de 48 px minimum, jamais 32 |
| Plein soleil | contraste renforcé, jamais de gris clair sur blanc |
| Écran de 5 pouces | une colonne, pas de tableau à défilement horizontal |
| Vieux matériel | pas de flou, pas d'ombre animée, transitions ≤ 150 ms |
| Hors ligne total | polices système, aucune ressource distante |
| Données mobiles payées | pas de webfont, pas d'icône chargée à la demande |
| Poste de saisie desktop | tout doit être atteignable au clavier seul |

### La saisie au clavier n'est pas un supplément

Sur le poste de saisie régional, une opératrice traite deux cents questionnaires
papier dans la journée. Elle ne touche pas la souris. Si `Tab` ne suit pas
l'ordre visuel, ou si valider une page demande un clic, le produit est plus lent
que la double saisie sous Excel qu'il remplace.

C'est un critère d'acceptation, pas une intention.

## 3. Jetons

Les couleurs, espacements et rayons sont des variables CSS. Aucune valeur en dur
dans un composant : une valeur en dur est une valeur qu'on ne pourra pas
corriger partout le jour où le contraste se révèle insuffisant sur un écran bon
marché.

**Contraste visé : 7:1 pour le texte courant**, soit le niveau AAA de la norme.
Le niveau AA à 4,5:1 est calibré pour un bureau, pas pour un trottoir à
Treichville à quatorze heures.

Le mode sombre existe parce qu'il économise la batterie sur les écrans OLED et
qu'il se lit mieux en fin de journée. Il n'est pas un thème décoratif : les
mêmes jetons, d'autres valeurs.

## 4. États d'une question

Une question porte au plus un état à la fois, et chaque état se lit **sans la
couleur seule** — daltonisme, écran délavé, plein soleil.

| État | Signal |
|---|---|
| normale | bordure neutre |
| ciblée | anneau de focus épais, visible au clavier comme au doigt |
| obligatoire non remplie | astérisque et texte, pas seulement un liseré |
| en violation | icône, texte explicite, bordure — les trois |
| non modifiable | fond atténué et curseur explicite |

Le message de violation vient du formulaire quand il existe
(`constraintMessage`), sinon d'un texte générique. Il est affiché **sous** le
champ, jamais dans une infobulle : une infobulle n'existe pas au doigt.

## 5. Ce que le paquet expose

- **Primitives** : bouton, champ, libellé, case, groupe radio, liste, zone de
  texte, carte. Construites sur des composants accessibles éprouvés plutôt que
  réécrites — un menu déroulant maison qui gère mal le clavier est un défaut
  d'accessibilité qu'on ne voit jamais en développement.
- **Rendus de questions**, un par type du schéma.
- **Un composant de formulaire** qui branche le tout sur `RuntimeSaisie` : il
  ne décide de rien, il affiche l'état et transmet les réponses.

Aucune logique métier ici. Pertinence, calculs, contraintes et navigation
viennent du runtime. Un rendu qui déciderait lui-même de masquer une question
créerait une deuxième vérité, et les deux divergeraient.

## 6. Accessibilité

Non négociable, et pas pour la conformité : un enquêteur malvoyant existe, et un
lecteur d'écran mal géré rend le produit inutilisable pour lui.

- Chaque champ a un libellé lié, jamais un simple texte à côté.
- Les messages d'erreur sont annoncés (`aria-live`), et référencés par
  `aria-describedby`.
- La navigation entre pages annonce le changement.
- `prefers-reduced-motion` supprime toute transition.
- Aucune information portée par la seule couleur.

## 7. Tests

Le rendu se teste par ce que voit l'utilisateur, pas par la structure interne :
un test qui interroge des classes CSS casse au premier changement de style sans
rien garantir.

- Un libellé est bien associé à son champ.
- Une violation est annoncée et rattachée au champ.
- Une question non pertinente n'est pas rendue.
- La saisie remonte au runtime, et l'affichage suit son état.
- Le parcours au clavier atteint tous les champs, dans l'ordre visuel.
- Les cibles tactiles respectent la taille minimale.
