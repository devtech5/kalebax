import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';

/**
 * Émission et vérification des jetons — docs/authentification.md §4.
 *
 * L'algorithme est **EdDSA (Ed25519)** : clés courtes, signature rapide, et
 * aucun paramètre qui puisse être mal choisi, contrairement à RSA.
 */
export const ALGORITHME = 'EdDSA';

export type RoleJeton = 'owner' | 'admin' | 'designer' | 'supervisor' | 'agent';

export interface ContenuJeton {
  /** Identifiant de l'utilisateur. */
  readonly sub: string;
  /** Organisation active de cette session. */
  readonly org: string;
  readonly role: RoleJeton;
  /** Jeton de rafraîchissement dont ce jeton d'accès est issu. */
  readonly sid: string;
}

export interface OptionsJetons {
  /** Clé privée Ed25519 au format PKCS#8 PEM. Générée à la volée si absente. */
  readonly clePriveePem?: string | undefined;
  readonly dureeAccesSecondes?: number | undefined;
  readonly emetteur?: string | undefined;
}

export interface CoupleRafraichissement {
  /** Le jeton en clair — il n'existe que sur l'appareil et dans cette réponse. */
  readonly jeton: string;
  /** Ce que la base conserve. */
  readonly empreinte: string;
}

@Injectable()
export class JetonsService {
  private clePrivee: CryptoKey | null = null;
  private clePublique: CryptoKey | null = null;
  private readonly dureeAcces: number;
  private readonly emetteur: string;

  constructor(private readonly options: OptionsJetons = {}) {
    this.dureeAcces = options.dureeAccesSecondes ?? 900;
    this.emetteur = options.emetteur ?? 'kalebax';
  }

  /**
   * Charge la clé de signature, ou en génère une en développement.
   *
   * En production, l'absence de `JWT_PRIVATE_KEY` doit empêcher l'application
   * de démarrer : une clé générée au lancement invaliderait toutes les sessions
   * à chaque redémarrage et différerait d'une instance à l'autre.
   */
  private async cles(): Promise<{ privee: CryptoKey; publique: CryptoKey }> {
    if (this.clePrivee !== null && this.clePublique !== null) {
      return { privee: this.clePrivee, publique: this.clePublique };
    }

    if (this.options.clePriveePem !== undefined && this.options.clePriveePem !== '') {
      const privee = await importPKCS8(this.options.clePriveePem, ALGORITHME, {
        extractable: true,
      });
      const paire = await derivePublique(privee);
      this.clePrivee = privee;
      this.clePublique = paire;
      return { privee, publique: paire };
    }

    const paire = await generateKeyPair(ALGORITHME, { extractable: true });
    this.clePrivee = paire.privateKey;
    this.clePublique = paire.publicKey;
    return { privee: paire.privateKey, publique: paire.publicKey };
  }

  /** Exporte la clé privée courante, pour la consigner dans l'environnement. */
  async exporterClePrivee(): Promise<string> {
    const { privee } = await this.cles();
    return exportPKCS8(privee);
  }

  async signerAcces(contenu: ContenuJeton): Promise<string> {
    const { privee } = await this.cles();
    return new SignJWT({ org: contenu.org, role: contenu.role, sid: contenu.sid })
      .setProtectedHeader({ alg: ALGORITHME })
      .setSubject(contenu.sub)
      .setIssuer(this.emetteur)
      .setIssuedAt()
      .setExpirationTime(`${this.dureeAcces}s`)
      .sign(privee);
  }

  /**
   * Vérifie un jeton d'accès.
   *
   * L'algorithme est **imposé**, jamais lu depuis l'en-tête : c'est ce qui
   * ferme `alg: none` et la substitution d'algorithme.
   */
  async verifierAcces(jeton: string): Promise<ContenuJeton> {
    const { publique } = await this.cles();
    const { payload } = await jwtVerify(jeton, publique, {
      algorithms: [ALGORITHME],
      issuer: this.emetteur,
    });

    const org = payload['org'];
    const role = payload['role'];
    const sid = payload['sid'];

    if (
      typeof payload.sub !== 'string' ||
      typeof org !== 'string' ||
      typeof role !== 'string' ||
      typeof sid !== 'string'
    ) {
      throw new Error('Jeton incomplet.');
    }

    return { sub: payload.sub, org, role: role as RoleJeton, sid };
  }

  /**
   * Produit un jeton de rafraîchissement.
   *
   * 256 bits d'aléa cryptographique. La base ne conserve qu'un condensat
   * SHA-256 : une fuite de la table ne donne aucune session utilisable. Le
   * condensat n'est pas salé, et c'est correct — la valeur d'origine est déjà
   * imprévisible, un sel ne protégerait que contre une attaque par
   * dictionnaire qui n'a aucun sens ici.
   */
  genererRafraichissement(): CoupleRafraichissement {
    const jeton = randomBytes(32).toString('base64url');
    return { jeton, empreinte: this.empreinte(jeton) };
  }

  empreinte(jeton: string): string {
    return createHash('sha256').update(jeton).digest('hex');
  }
}

/** jose n'expose pas la clé publique d'une clé privée : on la redérive par JWK. */
async function derivePublique(privee: CryptoKey): Promise<CryptoKey> {
  const { exportJWK, importJWK } = await import('jose');
  const jwk = await exportJWK(privee);
  delete jwk.d;
  const publique = await importJWK({ ...jwk, key_ops: ['verify'] }, ALGORITHME);
  if (publique instanceof Uint8Array) {
    throw new Error('Clé publique inattendue.');
  }
  return publique;
}
