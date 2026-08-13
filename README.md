# Kalebax

Plateforme de collecte de données terrain, conçue pour l'Afrique. Un concepteur
crée un formulaire depuis un navigateur, l'affecte à des agents, les agents
collectent sur leur téléphone **sans connexion**, les données remontent dès que
le réseau revient.

Trois cibles, deux rendus, un noyau : le desktop embarque le même bundle DOM que
la console web, et seul le rendu des questions existe deux fois — une fois en
DOM, une fois en React Native. Toute la logique est écrite une seule fois.

## Démarrage

```bash
pnpm install
docker compose up -d postgres
cp apps/api/.env.example apps/api/.env
pnpm --filter @kalebax/api prisma:migrate
pnpm --filter @kalebax/api start:dev
```

## Vérifications

```bash
pnpm test
pnpm typecheck
```

## Organisation

| Chemin | Contenu |
|---|---|
| `packages/shared` | schéma de formulaire, évaluateur d'expressions, versionnage, validation des soumissions |
| `apps/api` | NestJS, PostgreSQL, Prisma |
| `docs/` | une spécification par module, rédigée avant de coder |

Les règles de conception, les arbitrages et les contraintes du produit sont dans
[CLAUDE.md](CLAUDE.md). Chaque module a sa spécification dans `docs/`, écrite
avant le code et tenue à jour avec lui.

## Licence

Propriétaire. Tous droits réservés.
