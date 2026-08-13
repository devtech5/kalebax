import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Un seul lancement pour tout le monorepo : le jeu de tests de l'évaluateur
    // doit rester exécutable d'un bloc, à l'identique, où qu'il soit rejoué.
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
    ],
    coverage: {
      include: ['packages/*/src/**'],
    },
  },
});
