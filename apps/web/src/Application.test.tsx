// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from './Application.js';
import { ClientApi, stockageMemoire } from './api/client.js';

afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const JETONS = {
  acces: 'acces-1',
  rafraichissement: 'refresh-1',
  organizationId: 'org-1',
  role: 'designer',
};

/** Serveur simulé, alimenté par une file de réponses. */
function monter(reponses: (() => Response)[]) {
  const appels: { url: string; methode: string; corps: unknown }[] = [];

  const fetchSimule = (async (url: string | URL, init?: RequestInit) => {
    appels.push({
      url: String(url),
      methode: init?.method ?? 'GET',
      corps: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const suivante = reponses.shift();
    if (suivante === undefined) return new Response('[]', { status: 200 });
    return suivante();
  }) as unknown as typeof fetch;

  const client = new ClientApi({
    baseUrl: '/api',
    stockage: stockageMemoire(),
    fetch: fetchSimule,
  });

  render(<Application client={client} />);
  return { appels, client };
}

function json(corps: unknown, statut = 200): () => Response {
  return () =>
    new Response(JSON.stringify(corps), {
      status: statut,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('connexion', () => {
  it('demande les identifiants au démarrage', () => {
    monter([]);
    expect(screen.getByLabelText(/Adresse email/)).toBeDefined();
    expect(screen.getByLabelText(/Mot de passe/)).toBeDefined();
  });

  it('se connecte et affiche les projets', async () => {
    const utilisateur = userEvent.setup();
    monter([
      json({ type: 'jetons', jetons: JETONS }),
      json([{ id: 'p1', name: 'Audit T3', description: null, status: 'active' }]),
    ]);

    await utilisateur.type(screen.getByLabelText(/Adresse email/), 'awa@agence.ci');
    await utilisateur.type(screen.getByLabelText(/Mot de passe/), 'motdepasse');
    await utilisateur.click(screen.getByRole('button', { name: /Se connecter/ }));

    expect(await screen.findByText('Audit T3')).toBeDefined();
  });

  it('affiche le motif du refus', async () => {
    const utilisateur = userEvent.setup();
    monter([json({ message: 'Identifiants incorrects.' }, 401)]);

    await utilisateur.type(screen.getByLabelText(/Adresse email/), 'awa@agence.ci');
    await utilisateur.type(screen.getByLabelText(/Mot de passe/), 'faux');
    await utilisateur.click(screen.getByRole('button', { name: /Se connecter/ }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/Identifiants incorrects/)).toBeDefined();
  });

  it('fait choisir entre plusieurs organisations', async () => {
    // Un enquêteur travaille couramment pour deux agences concurrentes.
    const utilisateur = userEvent.setup();
    monter([
      json({
        type: 'choix',
        appartenances: [
          { organizationId: 'a', organizationName: 'Agence Alpha', role: 'designer' },
          { organizationId: 'b', organizationName: 'Institut Beta', role: 'supervisor' },
        ],
      }),
      json({ type: 'jetons', jetons: JETONS }),
      json([]),
    ]);

    await utilisateur.type(screen.getByLabelText(/Adresse email/), 'awa@agence.ci');
    await utilisateur.type(screen.getByLabelText(/Mot de passe/), 'motdepasse');
    await utilisateur.click(screen.getByRole('button', { name: /Se connecter/ }));

    expect(await screen.findByText(/Choisissez votre organisation/)).toBeDefined();
    await utilisateur.click(screen.getByRole('button', { name: 'Institut Beta' }));

    expect(await screen.findByText('Projets')).toBeDefined();
  });

  it('utilise les champs attendus par un gestionnaire de mots de passe', () => {
    // Sans ces attributs, chaque connexion est ressaisie à la main.
    monter([]);
    expect(screen.getByLabelText(/Adresse email/).getAttribute('autocomplete')).toBe(
      'username',
    );
    expect(screen.getByLabelText(/Mot de passe/).getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });
});

describe('projets', () => {
  async function connecter(reponses: (() => Response)[]) {
    const utilisateur = userEvent.setup();
    const contexte = monter([json({ type: 'jetons', jetons: JETONS }), ...reponses]);

    await utilisateur.type(screen.getByLabelText(/Adresse email/), 'awa@agence.ci');
    await utilisateur.type(screen.getByLabelText(/Mot de passe/), 'motdepasse');
    await utilisateur.click(screen.getByRole('button', { name: /Se connecter/ }));
    await screen.findByText('Projets');

    return { ...contexte, utilisateur };
  }

  it('explique un état vide au lieu de laisser une page blanche', async () => {
    await connecter([json([])]);
    expect(await screen.findByText(/Aucun projet pour l’instant/)).toBeDefined();
  });

  it('crée un projet et rafraîchit la liste', async () => {
    const { utilisateur, appels } = await connecter([
      json([]),
      json({ id: 'p1', name: 'Audit T3' }),
      json([{ id: 'p1', name: 'Audit T3', description: null, status: 'draft' }]),
    ]);

    await utilisateur.type(screen.getByLabelText(/Nouveau projet/), 'Audit T3');
    await utilisateur.click(screen.getByRole('button', { name: 'Créer' }));

    expect(await screen.findByText('Audit T3')).toBeDefined();
    const creation = appels.find((a) => a.methode === 'POST' && a.url.endsWith('/projects'));
    expect(creation?.corps).toEqual({ name: 'Audit T3' });
  });

  it('crée au clavier, sans passer par la souris', async () => {
    const { utilisateur, appels } = await connecter([
      json([]),
      json({ id: 'p1', name: 'Au clavier' }),
      json([{ id: 'p1', name: 'Au clavier', description: null, status: 'draft' }]),
    ]);

    await utilisateur.type(screen.getByLabelText(/Nouveau projet/), 'Au clavier{Enter}');

    expect(await screen.findByText('Au clavier')).toBeDefined();
    expect(appels.some((a) => a.methode === 'POST')).toBe(true);
  });

  it('ne crée rien à partir d\'un nom vide', async () => {
    const { utilisateur, appels } = await connecter([json([])]);
    await utilisateur.click(screen.getByRole('button', { name: 'Créer' }));

    expect(appels.filter((a) => a.methode === 'POST' && a.url.endsWith('/projects'))).toHaveLength(
      0,
    );
  });

  it('ouvre un projet', async () => {
    const { utilisateur } = await connecter([
      json([{ id: 'p1', name: 'Audit T3', description: null, status: 'active' }]),
    ]);

    await utilisateur.click(await screen.findByRole('button', { name: /Audit T3/ }));
    expect(screen.getByRole('heading', { name: 'Audit T3' })).toBeDefined();
  });

  it('signale un échec de chargement plutôt que d\'afficher une liste vide', async () => {
    // Une liste vide ferait croire qu'il n'y a pas de projet.
    await connecter([json({ message: 'Service indisponible.' }, 503)]);
    expect(await screen.findByRole('alert')).toBeDefined();
  });
});

describe('déconnexion', () => {
  it('ramène à l\'écran de connexion', async () => {
    const utilisateur = userEvent.setup();
    monter([json({ type: 'jetons', jetons: JETONS }), json([]), json(null, 204)]);

    await utilisateur.type(screen.getByLabelText(/Adresse email/), 'awa@agence.ci');
    await utilisateur.type(screen.getByLabelText(/Mot de passe/), 'motdepasse');
    await utilisateur.click(screen.getByRole('button', { name: /Se connecter/ }));
    await screen.findByText('Projets');

    await utilisateur.click(screen.getByRole('button', { name: /Déconnexion/ }));
    expect(await screen.findByLabelText(/Adresse email/)).toBeDefined();
  });
});
