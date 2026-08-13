/**
 * Client de l'API Kalebax.
 *
 * Il porte une contrainte que le serveur impose et qu'un client naïf viole
 * systématiquement : **la rotation des jetons de rafraîchissement révoque toute
 * la chaîne dès qu'un jeton déjà remplacé resurgit**
 * (docs/authentification.md §3). Deux rafraîchissements concurrents suffisent
 * donc à déconnecter l'utilisateur de toutes ses sessions.
 *
 * C'est exactement ce qui arrive lorsqu'une page lance trois requêtes en
 * parallèle et que le jeton d'accès vient d'expirer : les trois reçoivent 401,
 * les trois rafraîchissent, deux présentent un jeton déjà consommé. Le client
 * sérialise donc le rafraîchissement.
 */

export interface Jetons {
  readonly acces: string;
  readonly rafraichissement: string;
  readonly organizationId: string;
  readonly role: string;
}

export interface Appartenance {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: string;
}

export type ResultatConnexion =
  | { readonly type: 'jetons'; readonly jetons: Jetons }
  | { readonly type: 'choix'; readonly appartenances: readonly Appartenance[] };

export class ErreurApi extends Error {
  constructor(
    override readonly message: string,
    readonly statut: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ErreurApi';
  }
}

/**
 * Conservation des jetons.
 *
 * Le jeton d'accès ne vit qu'en mémoire : le déposer dans `localStorage`
 * l'exposerait à la moindre faille d'injection de script, et il ouvre l'accès à
 * des données personnelles d'enquêtés.
 *
 * Le jeton de rafraîchissement va dans `sessionStorage` — il survit à un
 * rechargement de page, pas à la fermeture de l'onglet. **La bonne réponse
 * reste un cookie `httpOnly` posé par l'API**, hors de portée du JavaScript ;
 * tant qu'elle n'est pas en place, cette dette est assumée et écrite ici plutôt
 * que dissimulée.
 */
export interface StockageSession {
  lire(): string | null;
  ecrire(jeton: string): void;
  effacer(): void;
}

export const CLE_SESSION = 'kalebax.rafraichissement';

export function stockageNavigateur(): StockageSession {
  return {
    lire: () => globalThis.sessionStorage?.getItem(CLE_SESSION) ?? null,
    ecrire: (jeton) => globalThis.sessionStorage?.setItem(CLE_SESSION, jeton),
    effacer: () => globalThis.sessionStorage?.removeItem(CLE_SESSION),
  };
}

export function stockageMemoire(): StockageSession {
  let valeur: string | null = null;
  return {
    lire: () => valeur,
    ecrire: (jeton) => {
      valeur = jeton;
    },
    effacer: () => {
      valeur = null;
    },
  };
}

export interface OptionsClient {
  readonly baseUrl: string;
  readonly stockage?: StockageSession | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Appelé quand la session est définitivement perdue. */
  readonly onDeconnexion?: (() => void) | undefined;
}

export class ClientApi {
  private acces: string | null = null;
  private organizationId: string | null = null;
  private role: string | null = null;
  /** Rafraîchissement en cours, partagé par tous les appels qui l'attendent. */
  private rafraichissementEnCours: Promise<boolean> | null = null;

  private readonly stockage: StockageSession;
  private readonly appeler: typeof fetch;

  constructor(private readonly options: OptionsClient) {
    this.stockage = options.stockage ?? stockageNavigateur();
    this.appeler = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  estConnecte(): boolean {
    return this.acces !== null || this.stockage.lire() !== null;
  }

  organisation(): string | null {
    return this.organizationId;
  }

  roleCourant(): string | null {
    return this.role;
  }

  /* ------------------------------------------------------ authentification */

  async connexion(
    email: string,
    motDePasse: string,
    organizationId?: string,
  ): Promise<ResultatConnexion> {
    const reponse = await this.requeteBrute('POST', '/auth/login', {
      email,
      motDePasse,
      ...(organizationId === undefined ? {} : { organizationId }),
    });

    const resultat = (await reponse.json()) as ResultatConnexion;
    if (resultat.type === 'jetons') this.enregistrer(resultat.jetons);
    return resultat;
  }

  async deconnexion(): Promise<void> {
    // On tente d'invalider la session côté serveur, mais l'échec ne doit pas
    // laisser l'utilisateur connecté dans son navigateur.
    try {
      await this.requete('POST', '/auth/logout');
    } catch {
      // ignoré volontairement
    }
    this.oublier();
  }

  private enregistrer(jetons: Jetons): void {
    this.acces = jetons.acces;
    this.organizationId = jetons.organizationId;
    this.role = jetons.role;
    this.stockage.ecrire(jetons.rafraichissement);
  }

  private oublier(): void {
    this.acces = null;
    this.organizationId = null;
    this.role = null;
    this.stockage.effacer();
  }

  /**
   * Rafraîchit la session, une seule fois même si dix appels le demandent.
   *
   * Sans cette sérialisation, la rotation côté serveur verrait un jeton déjà
   * remplacé revenir et révoquerait toute la chaîne : l'utilisateur serait
   * déconnecté par le succès de sa propre application.
   */
  private async rafraichir(): Promise<boolean> {
    if (this.rafraichissementEnCours !== null) return this.rafraichissementEnCours;

    this.rafraichissementEnCours = (async () => {
      const jeton = this.stockage.lire();
      if (jeton === null) return false;

      try {
        const reponse = await this.requeteBrute('POST', '/auth/refresh', {
          rafraichissement: jeton,
        });
        this.enregistrer((await reponse.json()) as Jetons);
        return true;
      } catch {
        this.oublier();
        this.options.onDeconnexion?.();
        return false;
      } finally {
        this.rafraichissementEnCours = null;
      }
    })();

    return this.rafraichissementEnCours;
  }

  /* -------------------------------------------------------------- requêtes */

  async requete<T>(
    methode: string,
    chemin: string,
    corps?: unknown,
  ): Promise<T> {
    let reponse = await this.envoyer(methode, chemin, corps);

    if (reponse.status === 401) {
      const rafraichi = await this.rafraichir();
      if (!rafraichi) {
        throw new ErreurApi('Session expirée.', 401);
      }
      // Une seule reprise : si le second essai échoue aussi, insister ne ferait
      // que boucler.
      reponse = await this.envoyer(methode, chemin, corps);
    }

    if (!reponse.ok) throw await erreurDepuis(reponse);
    if (reponse.status === 204) return undefined as T;
    return (await reponse.json()) as T;
  }

  private async envoyer(
    methode: string,
    chemin: string,
    corps?: unknown,
  ): Promise<Response> {
    const entetes: Record<string, string> = { Accept: 'application/json' };
    if (corps !== undefined) entetes['Content-Type'] = 'application/json';
    if (this.acces !== null) entetes['Authorization'] = `Bearer ${this.acces}`;

    // `body` absent plutôt que `undefined` : sous exactOptionalPropertyTypes,
    // les deux ne sont pas la même chose pour l'API du navigateur.
    const requete: RequestInit = { method: methode, headers: entetes };
    if (corps !== undefined) requete.body = JSON.stringify(corps);

    return this.appeler(`${this.options.baseUrl}${chemin}`, requete);
  }

  /** Appel sans jeton ni reprise, pour les routes d'authentification. */
  private async requeteBrute(
    methode: string,
    chemin: string,
    corps: unknown,
  ): Promise<Response> {
    const reponse = await this.appeler(`${this.options.baseUrl}${chemin}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corps),
    });
    if (!reponse.ok) throw await erreurDepuis(reponse);
    return reponse;
  }

  /* --------------------------------------------------------------- métier */

  projets<T>(): Promise<T> {
    return this.requete<T>('GET', '/projects');
  }

  creerProjet<T>(donnees: { name: string; description?: string }): Promise<T> {
    return this.requete<T>('POST', '/projects', donnees);
  }

  formulairesDuProjet<T>(projectId: string): Promise<T> {
    return this.requete<T>('GET', `/projects/${projectId}/forms`);
  }

  creerFormulaire<T>(projectId: string, donnees: { name: string }): Promise<T> {
    return this.requete<T>('POST', `/projects/${projectId}/forms`, donnees);
  }

  versionsDuFormulaire<T>(formId: string): Promise<T> {
    return this.requete<T>('GET', `/forms/${formId}/versions`);
  }

  documentCourant<T>(formId: string): Promise<T> {
    return this.requete<T>('GET', `/forms/${formId}/current`);
  }

  publierVersion<T>(versionId: string): Promise<T> {
    return this.requete<T>('POST', `/form-versions/${versionId}/publish`);
  }

  soumissions<T>(projectId?: string): Promise<T> {
    const requete = projectId === undefined ? '' : `?projectId=${projectId}`;
    return this.requete<T>('GET', `/submissions${requete}`);
  }
}

async function erreurDepuis(reponse: Response): Promise<ErreurApi> {
  let message = `Erreur ${reponse.status}`;
  let details: unknown;
  try {
    const corps = (await reponse.json()) as { message?: unknown };
    details = corps;
    if (typeof corps.message === 'string') message = corps.message;
  } catch {
    // Une réponse sans corps JSON reste une erreur exploitable.
  }
  return new ErreurApi(message, reponse.status, details);
}
