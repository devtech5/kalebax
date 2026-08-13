import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientApi, ErreurApi, stockageMemoire } from './client.js';

const BASE = 'https://api.test';

interface AppelSimule {
  readonly url: string;
  readonly methode: string;
  readonly corps: unknown;
  readonly autorisation: string | null;
}

/** Serveur simulé : file de réponses, et journal des appels reçus. */
function serveur() {
  const appels: AppelSimule[] = [];
  const reponses: (() => Response)[] = [];

  const repondre = (statut: number, corps: unknown = {}): (() => Response) =>
    () =>
      new Response(statut === 204 ? null : JSON.stringify(corps), {
        status: statut,
        headers: { 'Content-Type': 'application/json' },
      });

  const fetchSimule = (async (url: string | URL, init?: RequestInit) => {
    const entetes = new Headers(init?.headers);
    appels.push({
      url: String(url),
      methode: init?.method ?? 'GET',
      corps: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      autorisation: entetes.get('Authorization'),
    });
    const suivante = reponses.shift();
    if (suivante === undefined) throw new Error(`Réponse non prévue pour ${String(url)}`);
    return suivante();
  }) as unknown as typeof fetch;

  return { appels, reponses, repondre, fetchSimule };
}

const JETONS = {
  acces: 'acces-1',
  rafraichissement: 'refresh-1',
  organizationId: 'org-1',
  role: 'designer',
};

let simule: ReturnType<typeof serveur>;
let client: ClientApi;
let stockage: ReturnType<typeof stockageMemoire>;
let deconnexions: number;

beforeEach(() => {
  simule = serveur();
  stockage = stockageMemoire();
  deconnexions = 0;
  client = new ClientApi({
    baseUrl: BASE,
    stockage,
    fetch: simule.fetchSimule,
    onDeconnexion: () => {
      deconnexions += 1;
    },
  });
});

describe('connexion', () => {
  it('enregistre les jetons et l\'organisation', async () => {
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));

    const resultat = await client.connexion('awa@agence.ci', 'motdepasse');

    expect(resultat.type).toBe('jetons');
    expect(client.organisation()).toBe('org-1');
    expect(client.roleCourant()).toBe('designer');
  });

  it('ne garde jamais le jeton d\'accès hors de la mémoire', async () => {
    // Le déposer dans un stockage persistant l'exposerait à la moindre
    // injection de script, et il ouvre l'accès à des données d'enquêtés.
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));
    await client.connexion('awa@agence.ci', 'motdepasse');

    expect(stockage.lire()).toBe('refresh-1');
    expect(stockage.lire()).not.toBe('acces-1');
  });

  it('rend la liste des organisations quand il faut choisir', async () => {
    simule.reponses.push(
      simule.repondre(200, {
        type: 'choix',
        appartenances: [
          { organizationId: 'a', organizationName: 'Agence Alpha', role: 'designer' },
        ],
      }),
    );

    const resultat = await client.connexion('awa@agence.ci', 'motdepasse');
    expect(resultat.type).toBe('choix');
    expect(client.organisation()).toBeNull();
  });

  it('remonte une erreur d\'identifiants', async () => {
    simule.reponses.push(simule.repondre(401, { message: 'Identifiants incorrects.' }));

    await expect(client.connexion('awa@agence.ci', 'faux')).rejects.toThrow(ErreurApi);
  });
});

describe('requêtes authentifiées', () => {
  beforeEach(async () => {
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));
    await client.connexion('awa@agence.ci', 'motdepasse');
    simule.appels.length = 0;
  });

  it('porte le jeton d\'accès', async () => {
    simule.reponses.push(simule.repondre(200, []));
    await client.projets();

    expect(simule.appels[0]?.autorisation).toBe('Bearer acces-1');
  });

  it('gère une réponse sans corps', async () => {
    simule.reponses.push(simule.repondre(204));
    await expect(client.requete('POST', '/auth/logout')).resolves.toBeUndefined();
  });

  it('remonte le message du serveur', async () => {
    simule.reponses.push(
      simule.repondre(400, { message: 'Ce formulaire comporte des erreurs.' }),
    );

    await expect(client.publierVersion('v1')).rejects.toThrow(
      'Ce formulaire comporte des erreurs.',
    );
  });
});

describe('rafraîchissement', () => {
  beforeEach(async () => {
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));
    await client.connexion('awa@agence.ci', 'motdepasse');
    simule.appels.length = 0;
  });

  it('rejoue la requête après avoir rafraîchi', async () => {
    simule.reponses.push(
      simule.repondre(401, { message: 'Session invalide ou expirée.' }),
      simule.repondre(200, { ...JETONS, acces: 'acces-2', rafraichissement: 'refresh-2' }),
      simule.repondre(200, [{ id: 'p1' }]),
    );

    const projets = await client.projets<{ id: string }[]>();

    expect(projets).toEqual([{ id: 'p1' }]);
    expect(simule.appels[2]?.autorisation).toBe('Bearer acces-2');
    expect(stockage.lire()).toBe('refresh-2');
  });

  it('ne rafraîchit qu\'une fois pour des requêtes concurrentes', async () => {
    // Le serveur révoque toute la chaîne dès qu'un jeton déjà remplacé
    // resurgit : trois rafraîchissements simultanés déconnecteraient
    // l'utilisateur par le succès de sa propre application.
    simule.reponses.push(
      simule.repondre(401),
      simule.repondre(401),
      simule.repondre(401),
      simule.repondre(200, { ...JETONS, acces: 'acces-2', rafraichissement: 'refresh-2' }),
      simule.repondre(200, []),
      simule.repondre(200, []),
      simule.repondre(200, []),
    );

    await Promise.all([client.projets(), client.projets(), client.projets()]);

    const rafraichissements = simule.appels.filter((a) =>
      a.url.endsWith('/auth/refresh'),
    );
    expect(rafraichissements).toHaveLength(1);
  });

  it('ne présente jamais deux fois le même jeton de rafraîchissement', async () => {
    simule.reponses.push(
      simule.repondre(401),
      simule.repondre(401),
      simule.repondre(200, { ...JETONS, acces: 'acces-2', rafraichissement: 'refresh-2' }),
      simule.repondre(200, []),
      simule.repondre(200, []),
    );

    await Promise.all([client.projets(), client.projets()]);

    const presentes = simule.appels
      .filter((a) => a.url.endsWith('/auth/refresh'))
      .map((a) => (a.corps as { rafraichissement: string }).rafraichissement);

    expect(new Set(presentes).size).toBe(presentes.length);
  });

  it('abandonne après un rafraîchissement refusé', async () => {
    simule.reponses.push(
      simule.repondre(401),
      simule.repondre(401, { message: 'Session invalide ou expirée.' }),
    );

    await expect(client.projets()).rejects.toThrow(ErreurApi);
    expect(deconnexions).toBe(1);
    expect(client.estConnecte()).toBe(false);
  });

  it('ne boucle pas si la reprise échoue à son tour', async () => {
    simule.reponses.push(
      simule.repondre(401),
      simule.repondre(200, { ...JETONS, acces: 'acces-2', rafraichissement: 'refresh-2' }),
      simule.repondre(401, { message: 'Session invalide ou expirée.' }),
    );

    await expect(client.projets()).rejects.toThrow(ErreurApi);
    expect(simule.reponses).toHaveLength(0);
  });

  it('ne tente rien sans jeton de rafraîchissement', async () => {
    stockage.effacer();
    simule.reponses.push(simule.repondre(401));

    await expect(client.projets()).rejects.toThrow('Session expirée.');
    expect(simule.appels.filter((a) => a.url.endsWith('/auth/refresh'))).toHaveLength(0);
  });
});

describe('déconnexion', () => {
  beforeEach(async () => {
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));
    await client.connexion('awa@agence.ci', 'motdepasse');
  });

  it('efface la session même si le serveur ne répond pas', async () => {
    // Un échec réseau ne doit pas laisser l'utilisateur connecté dans son
    // navigateur.
    simule.reponses.push(() => {
      throw new Error('réseau indisponible');
    });

    await client.deconnexion();
    expect(client.estConnecte()).toBe(false);
    expect(stockage.lire()).toBeNull();
  });

  it('prévient le serveur quand elle le peut', async () => {
    simule.reponses.push(simule.repondre(204));
    await client.deconnexion();

    expect(simule.appels.some((a) => a.url.endsWith('/auth/logout'))).toBe(true);
  });
});

describe('reprise de session', () => {
  it('se sait connecté grâce au jeton conservé', () => {
    stockage.ecrire('refresh-conserve');
    expect(client.estConnecte()).toBe(true);
  });

  it('rafraîchit à la première requête après un rechargement de page', async () => {
    stockage.ecrire('refresh-conserve');
    simule.reponses.push(
      simule.repondre(401),
      simule.repondre(200, JETONS),
      simule.repondre(200, []),
    );

    await client.projets();
    expect(client.organisation()).toBe('org-1');
  });
});

describe('journal', () => {
  it('n\'écrit jamais un jeton dans la console', async () => {
    // Un jeton dans les journaux d'un navigateur partagé au bureau régional
    // est un jeton divulgué.
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    simule.reponses.push(simule.repondre(200, { type: 'jetons', jetons: JETONS }));

    await client.connexion('awa@agence.ci', 'motdepasse');

    expect(espion).not.toHaveBeenCalled();
    espion.mockRestore();
  });
});
