import { randomUUID } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService, LIMITES_OTP } from './auth.service.js';
import type { CanalEnvoi, EnvoyeurCode } from './envoi-code.port.js';
import { JetonsService } from './jetons.service.js';
import { PrismaMemoire } from './prisma-memoire.js';
import { SecretsService } from './secrets.service.js';

const EMAIL = 'awa@agence.ci';
const TELEPHONE = '+2250700000001';
const MOT_DE_PASSE = 'un mot de passe de terrain';

class EnvoyeurEspion implements EnvoyeurCode {
  readonly envois: { telephone: string; code: string; canal: CanalEnvoi }[] = [];
  async envoyer(telephone: string, code: string, canal: CanalEnvoi): Promise<void> {
    this.envois.push({ telephone, code, canal });
  }
}

let base: PrismaMemoire;
let envoyeur: EnvoyeurEspion;
let service: AuthService;
let secrets: SecretsService;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER = randomUUID();

beforeEach(async () => {
  base = new PrismaMemoire();
  envoyeur = new EnvoyeurEspion();
  secrets = new SecretsService();
  service = new AuthService(
    base.enServicePrisma(),
    new JetonsService(),
    secrets,
    envoyeur,
  );

  base.organisations.push(
    { id: ORG_A, name: 'Agence Alpha', offlineGraceDays: 7, status: 'active' },
    { id: ORG_B, name: 'Institut Beta', offlineGraceDays: 30, status: 'active' },
  );
  base.utilisateurs.push({
    id: USER,
    email: EMAIL,
    phone: TELEPHONE,
    passwordHash: await secrets.hacher(MOT_DE_PASSE),
    status: 'active',
  });
  base.appartenances.push({
    userId: USER,
    organizationId: ORG_A,
    role: 'designer',
    status: 'active',
  });
});

describe('connexion par mot de passe', () => {
  it('émet des jetons pour des identifiants corrects', async () => {
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE);
    expect(resultat.type).toBe('jetons');
    if (resultat.type !== 'jetons') return;
    expect(resultat.jetons.organizationId).toBe(ORG_A);
    expect(resultat.jetons.role).toBe('designer');
    expect(resultat.jetons.acces).toBeTruthy();
  });

  it('refuse un mot de passe incorrect', async () => {
    await expect(service.connexionMotDePasse(EMAIL, 'faux')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('normalise la casse et les espaces de l\'adresse', async () => {
    const resultat = await service.connexionMotDePasse(`  ${EMAIL.toUpperCase()} `, MOT_DE_PASSE);
    expect(resultat.type).toBe('jetons');
  });

  it('donne le même message pour un compte inconnu', async () => {
    // Rien ne doit permettre de savoir quelles adresses sont enregistrées.
    const inconnu = await attraper(() => service.connexionMotDePasse('rien@nulle.part', 'x'));
    const mauvais = await attraper(() => service.connexionMotDePasse(EMAIL, 'faux'));
    expect(inconnu).toBe(mauvais);
  });

  it('consomme du temps sur un compte inconnu', async () => {
    // Un message identique ne suffit pas : la latence parle aussi.
    const debut = performance.now();
    await attraper(() => service.connexionMotDePasse('rien@nulle.part', 'x'));
    expect(performance.now() - debut).toBeGreaterThan(5);
  });

  it('refuse un compte suspendu', async () => {
    base.utilisateurs[0]!.status = 'suspended';
    await expect(service.connexionMotDePasse(EMAIL, MOT_DE_PASSE)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un agent sans mot de passe', async () => {
    base.utilisateurs[0]!.passwordHash = null;
    await expect(service.connexionMotDePasse(EMAIL, MOT_DE_PASSE)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('appartenance à plusieurs organisations', () => {
  beforeEach(() => {
    base.appartenances.push({
      userId: USER,
      organizationId: ORG_B,
      role: 'supervisor',
      status: 'active',
    });
  });

  it('n\'émet aucun jeton tant que l\'organisation n\'est pas choisie', async () => {
    // Un enquêteur travaille couramment pour deux agences concurrentes.
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE);
    expect(resultat.type).toBe('choix');
    if (resultat.type !== 'choix') return;
    expect(resultat.appartenances).toHaveLength(2);
    expect(resultat.appartenances.map((a) => a.organizationName).sort()).toEqual([
      'Agence Alpha',
      'Institut Beta',
    ]);
  });

  it('émet des jetons pour l\'organisation choisie', async () => {
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE, ORG_B);
    expect(resultat.type).toBe('jetons');
    if (resultat.type !== 'jetons') return;
    expect(resultat.jetons.organizationId).toBe(ORG_B);
    expect(resultat.jetons.role).toBe('supervisor');
    expect(resultat.jetons.toleranceHorsLigneJours).toBe(30);
  });

  it('ne révèle pas l\'existence d\'une organisation étrangère', async () => {
    // Demander une organisation à laquelle on n'appartient pas rend la liste
    // réelle, sans distinguer « inexistante » de « pas la vôtre ».
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE, randomUUID());
    expect(resultat.type).toBe('choix');
  });

  it('ignore une appartenance révoquée dans le choix', async () => {
    base.appartenances[1]!.status = 'revoked';
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE);
    expect(resultat.type).toBe('jetons');
  });
});

describe('code à usage unique', () => {
  it('envoie un code à un numéro connu', async () => {
    await service.demanderCode(TELEPHONE);
    expect(envoyeur.envois).toHaveLength(1);
    expect(envoyeur.envois[0]?.code).toMatch(/^\d{6}$/);
    expect(envoyeur.envois[0]?.canal).toBe('whatsapp');
  });

  it('n\'envoie rien à un numéro inconnu, sans le dire', async () => {
    // Sinon l'API devient un annuaire des agents d'une organisation.
    await expect(service.demanderCode('+2250799999999')).resolves.toBeUndefined();
    expect(envoyeur.envois).toHaveLength(0);
  });

  it('enregistre le défi même pour un numéro inconnu', async () => {
    // Sans quoi les limites de débit elles-mêmes révèlent quels numéros
    // existent.
    await service.demanderCode('+2250799999999');
    expect(base.defis).toHaveLength(1);
  });

  it('ne stocke jamais le code en clair', async () => {
    await service.demanderCode(TELEPHONE);
    const code = envoyeur.envois[0]!.code;
    expect(base.defis[0]!.codeHash).not.toContain(code);
    expect(base.defis[0]!.codeHash.startsWith('$argon2id$')).toBe(true);
  });

  it('ouvre une session avec le bon code', async () => {
    await service.demanderCode(TELEPHONE);
    const resultat = await service.verifierCode(TELEPHONE, envoyeur.envois[0]!.code);
    expect(resultat.type).toBe('jetons');
  });

  it('refuse un code erroné', async () => {
    await service.demanderCode(TELEPHONE);
    await expect(service.verifierCode(TELEPHONE, '000000')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('brûle le défi après trois tentatives', async () => {
    await service.demanderCode(TELEPHONE);
    const bonCode = envoyeur.envois[0]!.code;

    for (let i = 0; i < LIMITES_OTP.tentativesParDefi; i += 1) {
      await attraper(() => service.verifierCode(TELEPHONE, '000000'));
    }

    // Même le bon code ne passe plus.
    await expect(service.verifierCode(TELEPHONE, bonCode)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un code déjà consommé', async () => {
    await service.demanderCode(TELEPHONE);
    const code = envoyeur.envois[0]!.code;
    await service.verifierCode(TELEPHONE, code);
    await expect(service.verifierCode(TELEPHONE, code)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un code expiré', async () => {
    await service.demanderCode(TELEPHONE);
    base.defis[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(
      service.verifierCode(TELEPHONE, envoyeur.envois[0]!.code),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('limite le nombre de demandes par heure', async () => {
    // Un SMS coûte de l'argent : une boucle de demandes est autant un vol
    // qu'un déni de service.
    for (let i = 0; i < LIMITES_OTP.parHeure; i += 1) {
      await service.demanderCode(TELEPHONE);
    }
    await expect(service.demanderCode(TELEPHONE)).rejects.toThrow(HttpException);
  });

  it('applique la limite aussi aux numéros inconnus', async () => {
    const inconnu = '+2250788888888';
    for (let i = 0; i < LIMITES_OTP.parHeure; i += 1) {
      await service.demanderCode(inconnu);
    }
    await expect(service.demanderCode(inconnu)).rejects.toThrow(HttpException);
  });
});

describe('rotation du jeton de rafraîchissement', () => {
  async function ouvrirSession(): Promise<string> {
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE);
    if (resultat.type !== 'jetons') throw new Error('session attendue');
    return resultat.jetons.rafraichissement;
  }

  it('échange un jeton contre un nouveau couple', async () => {
    const premier = await ouvrirSession();
    const jetons = await service.rafraichir(premier);
    expect(jetons.rafraichissement).not.toBe(premier);
    expect(jetons.acces).toBeTruthy();
  });

  it('révoque le jeton présenté', async () => {
    const premier = await ouvrirSession();
    await service.rafraichir(premier);
    await expect(service.rafraichir(premier)).rejects.toThrow(UnauthorizedException);
  });

  it('révoque toute la chaîne quand un jeton déjà remplacé resurgit', async () => {
    // L'appareil légitime a reçu le suivant : si l'ancien revient, il a été
    // copié.
    const premier = await ouvrirSession();
    const deuxieme = (await service.rafraichir(premier)).rafraichissement;

    await attraper(() => service.rafraichir(premier));

    // Le jeton du voleur comme celui de l'agent sont désormais inutilisables.
    await expect(service.rafraichir(deuxieme)).rejects.toThrow(UnauthorizedException);
    expect(base.jetons.every((j) => j.revokedAt !== null)).toBe(true);
  });

  it('chaîne les jetons pour tracer la rotation', async () => {
    const premier = await ouvrirSession();
    await service.rafraichir(premier);
    const ancien = base.jetons[0]!;
    expect(ancien.replacedById).toBe(base.jetons[1]!.id);
  });

  it('refuse un jeton expiré', async () => {
    const premier = await ouvrirSession();
    base.jetons[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(service.rafraichir(premier)).rejects.toThrow(UnauthorizedException);
  });

  it('refuse un jeton inconnu', async () => {
    await expect(service.rafraichir('jeton-invente')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('reprend le rôle courant et non celui d\'origine', async () => {
    // Une promotion ou une rétrogradation prend effet au rafraîchissement.
    const premier = await ouvrirSession();
    base.appartenances[0]!.role = 'admin';
    expect((await service.rafraichir(premier)).role).toBe('admin');
  });

  it('refuse le rafraîchissement si l\'appartenance a disparu', async () => {
    const premier = await ouvrirSession();
    base.appartenances.length = 0;
    await expect(service.rafraichir(premier)).rejects.toThrow(UnauthorizedException);
  });

  it('laisse rafraîchir un membre révoqué', async () => {
    // Il doit pouvoir envoyer ce qu'il a déjà collecté ; c'est la couche de
    // portée qui lui interdit toute nouvelle écriture.
    const premier = await ouvrirSession();
    base.appartenances[0]!.status = 'revoked';
    await expect(service.rafraichir(premier)).resolves.toBeDefined();
  });
});

describe('révocation de session', () => {
  it('rend un jeton inutilisable', async () => {
    const resultat = await service.connexionMotDePasse(EMAIL, MOT_DE_PASSE);
    if (resultat.type !== 'jetons') throw new Error('session attendue');

    await service.revoquerSession(base.jetons[0]!.id);
    await expect(service.rafraichir(resultat.jetons.rafraichissement)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

async function attraper(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
