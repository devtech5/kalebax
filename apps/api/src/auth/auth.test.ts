import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { JetonsService, type ContenuJeton } from './jetons.service.js';
import { SecretsService } from './secrets.service.js';

function contenu(extra: Partial<ContenuJeton> = {}): ContenuJeton {
  return {
    sub: 'user-1',
    org: 'org-1',
    role: 'agent',
    sid: 'session-1',
    ...extra,
  };
}

describe('jetons d\'accès', () => {
  it('signe et relit un jeton', async () => {
    const service = new JetonsService();
    const jeton = await service.signerAcces(contenu());
    expect(await service.verifierAcces(jeton)).toEqual(contenu());
  });

  it('refuse un jeton signé par une autre clé', async () => {
    const emetteur = new JetonsService();
    const autre = new JetonsService();
    const jeton = await emetteur.signerAcces(contenu());
    await expect(autre.verifierAcces(jeton)).rejects.toThrow();
  });

  it('refuse un jeton expiré', async () => {
    const service = new JetonsService({ dureeAccesSecondes: -1 });
    const jeton = await service.signerAcces(contenu());
    await expect(service.verifierAcces(jeton)).rejects.toThrow();
  });

  it('refuse un jeton non signé', async () => {
    // alg: none est la première chose qu'essaie un attaquant : un jeton dont
    // la signature est vide, avec le rôle propriétaire dans le contenu.
    const service = new JetonsService();
    const enTete = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const corps = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        org: 'org-1',
        role: 'owner',
        sid: 's',
        iss: 'kalebax',
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');

    await expect(service.verifierAcces(`${enTete}.${corps}.`)).rejects.toThrow();
  });

  it('refuse un jeton signé avec un autre algorithme', async () => {
    // La vérification impose EdDSA au lieu de lire l'en-tête pour choisir.
    const service = new JetonsService();
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jeton = await new SignJWT({ org: 'org-1', role: 'owner', sid: 's' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setIssuer('kalebax')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
    await expect(service.verifierAcces(jeton)).rejects.toThrow();
  });

  it('refuse un jeton d\'un autre émetteur', async () => {
    const etranger = new JetonsService({ emetteur: 'autre-produit' });
    const cle = await etranger.exporterClePrivee();
    const service = new JetonsService({ clePriveePem: cle });
    const jeton = await etranger.signerAcces(contenu());
    await expect(service.verifierAcces(jeton)).rejects.toThrow();
  });

  it('réutilise une clé fournie plutôt que d\'en générer une', async () => {
    // Une clé générée au démarrage invaliderait toutes les sessions à chaque
    // redémarrage et différerait d'une instance à l'autre.
    const premier = new JetonsService();
    const pem = await premier.exporterClePrivee();

    const emetteur = new JetonsService({ clePriveePem: pem });
    const verificateur = new JetonsService({ clePriveePem: pem });

    const jeton = await emetteur.signerAcces(contenu());
    expect(await verificateur.verifierAcces(jeton)).toEqual(contenu());
  });

  it('transporte l\'organisation et le rôle', async () => {
    const service = new JetonsService();
    const jeton = await service.signerAcces(contenu({ org: 'org-9', role: 'supervisor' }));
    const relu = await service.verifierAcces(jeton);
    expect(relu.org).toBe('org-9');
    expect(relu.role).toBe('supervisor');
  });
});

describe('jetons de rafraîchissement', () => {
  const service = new JetonsService();

  it('produit un jeton imprévisible', () => {
    const vus = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      vus.add(service.genererRafraichissement().jeton);
    }
    expect(vus.size).toBe(200);
  });

  it('ne conserve qu\'un condensat', () => {
    // Une fuite de la table ne doit donner aucune session utilisable.
    const { jeton, empreinte } = service.genererRafraichissement();
    expect(empreinte).not.toContain(jeton);
    expect(empreinte).toHaveLength(64);
    expect(service.empreinte(jeton)).toBe(empreinte);
  });
});

describe('secrets', () => {
  const service = new SecretsService();

  it('hache et vérifie un mot de passe', async () => {
    const condensat = await service.hacher('un mot de passe de terrain');
    expect(condensat.startsWith('$argon2id$')).toBe(true);
    expect(await service.verifier(condensat, 'un mot de passe de terrain')).toBe(true);
    expect(await service.verifier(condensat, 'autre chose')).toBe(false);
  });

  it('produit un condensat différent à chaque fois', async () => {
    const a = await service.hacher('identique');
    const b = await service.hacher('identique');
    expect(a).not.toBe(b);
  });

  it('ne lève pas sur un condensat corrompu', async () => {
    // Un enregistrement abîmé est un échec d'authentification, pas une panne.
    expect(await service.verifier('pas un condensat', 'secret')).toBe(false);
    expect(await service.verifier('', 'secret')).toBe(false);
  });

  it('consomme du temps sur un compte inconnu', async () => {
    // Sans cela, l'écart de latence révèle quelles adresses existent.
    const debut = performance.now();
    expect(await service.verifierLeurre('tentative')).toBe(false);
    expect(performance.now() - debut).toBeGreaterThan(5);
  });

  it('génère un code à six chiffres', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = service.genererCodeOtp();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('couvre toute la plage, y compris les codes à zéros de tête', () => {
    const codes = Array.from({ length: 3000 }, () => service.genererCodeOtp());
    expect(new Set(codes).size).toBeGreaterThan(2500);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
  });

  it('compare à temps constant', () => {
    expect(service.comparerConstant('abc', 'abc')).toBe(true);
    expect(service.comparerConstant('abc', 'abd')).toBe(false);
    expect(service.comparerConstant('abc', 'abcd')).toBe(false);
  });
});
