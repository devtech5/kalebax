import {
  MagasinSql,
  PiloteSqlNode,
  type MagasinLocal,
  type SoumissionAFinaliser,
} from '@kalebax/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { MoteurSync } from './moteur.js';
import { FichiersSimules, TransportSimule } from './transport-simule.js';
import { ErreurTransport } from './transport.js';

const HORODATAGE = '2026-08-13T09:00:00.000Z';

let magasin: MagasinLocal;
let transport: TransportSimule;
let fichiers: FichiersSimules;
let moteur: MoteurSync;

function aFinaliser(id: string, nombreMedias = 0, tailleMedia = 300_000): SoumissionAFinaliser {
  return {
    soumission: {
      id,
      formVersionId: 'version-1',
      projectId: 'projet-1',
      data: { nom: `Boutique ${id}`, prix: 500 },
      startedAt: HORODATAGE,
      completedAt: '2026-08-13T09:12:00.000Z',
      deviceId: 'tecno-spark-8',
      appVersion: '1.0.0',
      startLatitude: 5.333862,
      startLongitude: -4.07025,
      startAccuracy: 12,
      startGeopointStatus: 'captured',
    },
    medias: Array.from({ length: nombreMedias }, (_, index) => ({
      id: `${id}-media-${index}`,
      submissionId: id,
      questionName: 'photos',
      kind: 'photo' as const,
      cheminFichier: `/media/${id}-${index}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: tailleMedia,
      checksum: 'a'.repeat(64),
      capturedAt: HORODATAGE,
      latitude: null,
      longitude: null,
    })),
  };
}

beforeEach(async () => {
  magasin = new MagasinSql(new PiloteSqlNode());
  await magasin.ouvrir();
  transport = new TransportSimule();
  fichiers = new FichiersSimules();
  // Hasard figé : la temporisation doit être vérifiable.
  moteur = new MoteurSync(magasin, transport, fichiers, { hasard: () => 0.5 });
});

describe('envoi des soumissions', () => {
  it('envoie et confirme une soumission', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    const rapport = await moteur.synchroniser();

    expect(rapport.soumissionsConfirmees).toBe(1);
    expect(transport.recues.has('s1')).toBe(true);
    expect((await magasin.lireSoumission('s1'))?.etat).toBe('confirmee');
  });

  it('vide la file en plusieurs lots', async () => {
    for (let i = 0; i < 60; i += 1) {
      await magasin.finaliserSoumission(aFinaliser(`s${String(i).padStart(3, '0')}`));
    }
    const rapport = await moteur.synchroniser();

    expect(rapport.soumissionsConfirmees).toBe(60);
    expect(transport.appelsLot.length).toBeGreaterThanOrEqual(3);
    expect((await magasin.compterParEtat()).en_attente).toBe(0);
  });

  it('respecte la borne de 25 soumissions par lot', async () => {
    for (let i = 0; i < 30; i += 1) {
      await magasin.finaliserSoumission(aFinaliser(`s${String(i).padStart(3, '0')}`));
    }
    await moteur.synchroniser();

    for (const appel of transport.appelsLot) {
      expect(appel.length).toBeLessThanOrEqual(25);
    }
  });

  it('n\'envoie rien quand la file est vide', async () => {
    const rapport = await moteur.synchroniser();
    expect(rapport.lotsEnvoyes).toBe(0);
    expect(transport.appelsLot).toHaveLength(0);
  });

  it('respecte la limite de lots demandée', async () => {
    for (let i = 0; i < 60; i += 1) {
      await magasin.finaliserSoumission(aFinaliser(`s${String(i).padStart(3, '0')}`));
    }
    const rapport = await moteur.synchroniser({ lotsMax: 1 });

    expect(rapport.lotsEnvoyes).toBe(1);
    expect((await magasin.compterParEtat()).confirmee).toBe(25);
  });
});

describe('coupure et rejeu', () => {
  it('ne perd rien quand la réponse se perd', async () => {
    // Le serveur a enregistré, la réponse n'est jamais arrivée : l'appareil ne
    // sait pas si c'est passé.
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.perdreLaReponse = true;

    const premier = await moteur.synchroniser();
    expect(premier.soumissionsConfirmees).toBe(0);
    expect(premier.soumissionsReportees).toBe(1);
    expect(transport.recues.has('s1')).toBe(true);
    expect(await magasin.lireSoumission('s1')).not.toBeNull();
  });

  it('ne duplique pas au rejeu', async () => {
    // C'est tout l'intérêt de l'identifiant généré côté client.
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.perdreLaReponse = true;
    await moteur.synchroniser();

    // Le délai de temporisation est passé.
    const plusTard = new Date(Date.now() + 3_600_000);
    const moteurPlusTard = new MoteurSync(magasin, transport, fichiers, {
      hasard: () => 0.5,
      maintenant: () => plusTard,
    });
    const second = await moteurPlusTard.synchroniser();

    expect(second.soumissionsConfirmees).toBe(1);
    expect(transport.recues.size).toBe(1);
    expect((await magasin.lireSoumission('s1'))?.etat).toBe('confirmee');
  });

  it('rejoue dix fois sans jamais dupliquer', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    for (let i = 0; i < 10; i += 1) {
      transport.perdreLaReponse = true;
      const instant = new Date(Date.now() + i * 7_200_000);
      await new MoteurSync(magasin, transport, fichiers, {
        hasard: () => 0.5,
        maintenant: () => instant,
      }).synchroniser();
    }
    expect(transport.recues.size).toBe(1);
  });

  it('repousse la file sur une panne réseau', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.prochaineErreurLot = new ErreurTransport('Réseau absent', true, 'reseau');

    const rapport = await moteur.synchroniser();
    expect(rapport.interrompuPar).toBe('reseau');
    expect(rapport.soumissionsReportees).toBe(1);

    const relue = await magasin.lireSoumission('s1');
    expect(relue?.etat).toBe('en_attente');
    expect(relue?.nombreTentatives).toBe(1);
  });

  it('ne remonte pas une soumission avant son délai', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.prochaineErreurLot = new ErreurTransport('Réseau absent', true, 'reseau');
    await moteur.synchroniser();

    const rapport = await moteur.synchroniser();
    expect(rapport.lotsEnvoyes).toBe(0);
  });

  it('garde en file un élément absent de la réponse', async () => {
    // Un lot partiellement traité est un succès partiel, pas un échec.
    await magasin.finaliserSoumission(aFinaliser('s1'));
    await magasin.finaliserSoumission(aFinaliser('s2'));
    transport.resultatsPartiels = 1;

    const rapport = await moteur.synchroniser({ lotsMax: 1 });
    expect(rapport.soumissionsConfirmees).toBe(1);
    expect(rapport.soumissionsReportees).toBe(1);
  });

  it('s\'arrête sans rien reporter sur une erreur définitive', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.prochaineErreurLot = new ErreurTransport(
      'Organisation suspendue',
      false,
      'organisation-suspendue',
    );

    const rapport = await moteur.synchroniser();
    expect(rapport.interrompuPar).toBe('organisation-suspendue');
    expect((await magasin.lireSoumission('s1'))?.etat).toBe('envoyee');
  });
});

describe('refus du serveur', () => {
  it('sort de la file une soumission refusée, sans la supprimer', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.aRefuser.add('s1');

    const rapport = await moteur.synchroniser();
    expect(rapport.soumissionsRefusees).toBe(1);

    const relue = await magasin.lireSoumission('s1');
    expect(relue?.etat).toBe('echec_permanent');
    expect(relue?.codeEchec).toBe('version-inconnue');
    expect(relue?.data).toEqual({ nom: 'Boutique s1', prix: 500 });
  });

  it('ne laisse pas un refus bloquer les autres', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1'));
    await magasin.finaliserSoumission(aFinaliser('s2'));
    transport.aRefuser.add('s1');

    const rapport = await moteur.synchroniser();
    expect(rapport.soumissionsRefusees).toBe(1);
    expect(rapport.soumissionsConfirmees).toBe(1);
  });

  it('traite un rejet de validation comme un accusé', async () => {
    // La donnée est enregistrée côté serveur avec ses violations : ce n'est pas
    // un échec de transmission.
    await magasin.finaliserSoumission(aFinaliser('s1'));
    transport.envoyerLot = async (soumissions) =>
      soumissions.map((s) => ({ id: s.id, etat: 'recue' as const, status: 'rejected' }));

    await moteur.synchroniser();
    const relue = await magasin.lireSoumission('s1');
    expect(relue?.etat).toBe('confirmee');
    expect(relue?.statutServeur).toBe('rejected');
  });
});

describe('médias', () => {
  it('ne les envoie pas par défaut', async () => {
    // L'agent paie souvent son forfait : le texte part, les photos attendent.
    await magasin.finaliserSoumission(aFinaliser('s1', 1));
    const rapport = await moteur.synchroniser();

    expect(rapport.mediasMontes).toBe(0);
    expect((await magasin.lireSoumission('s1'))?.etat).toBe('medias_en_attente');
  });

  it('les envoie quand on le demande', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 1));
    const rapport = await moteur.synchroniser({ inclureMedias: true });

    expect(rapport.mediasMontes).toBe(1);
    expect(rapport.octetsMediasEnvoyes).toBe(300_000);
    expect((await magasin.lireSoumission('s1'))?.etat).toBe('confirmee');
  });

  it('découpe en morceaux de 256 Ko', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 1, 600_000));
    await moteur.synchroniser({ inclureMedias: true });

    const longueurs = fichiers.lectures.map((l) => l.longueur);
    expect(longueurs).toEqual([262_144, 262_144, 75_712]);
  });

  it('envoie un petit fichier d\'un seul coup', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 1, 10_000));
    await moteur.synchroniser({ inclureMedias: true });
    expect(fichiers.lectures).toHaveLength(1);
  });

  it('reprend à l\'octet près après une coupure', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 1, 600_000));
    transport.couperMediaApres = 300_000;

    const premier = await moteur.synchroniser({ inclureMedias: true });
    expect(premier.mediasMontes).toBe(0);
    expect(premier.interrompuPar).toBe('coupure');

    const progression = (await magasin.listerMediasDeSoumission('s1'))[0];
    expect(progression?.octetsEnvoyes).toBe(262_144);

    fichiers.lectures.length = 0;
    const second = await moteur.synchroniser({ inclureMedias: true });
    expect(second.mediasMontes).toBe(1);
    // La reprise part de l'offset serveur, elle ne recommence pas.
    expect(fichiers.lectures[0]?.offset).toBe(262_144);
  });

  it('fait confiance au serveur sur ce qu\'il détient déjà', async () => {
    // Un compteur local divergerait au premier redémarrage brutal.
    await magasin.finaliserSoumission(aFinaliser('s1', 1, 600_000));
    transport.offsetsInitiaux.set('s1-media-0', 400_000);

    await moteur.synchroniser({ inclureMedias: true });
    expect(fichiers.lectures[0]?.offset).toBe(400_000);
  });

  it('recommence de zéro quand l\'empreinte est refusée', async () => {
    // Un média corrompu vaut moins que pas de média : il fait croire à une
    // preuve.
    await magasin.finaliserSoumission(aFinaliser('s1', 1, 300_000));
    transport.checksumsARefuser.add('s1-media-0');

    const premier = await moteur.synchroniser({ inclureMedias: true });
    expect(premier.mediasMontes).toBe(0);
    expect((await magasin.listerMediasDeSoumission('s1'))[0]?.octetsEnvoyes).toBe(0);

    const second = await moteur.synchroniser({ inclureMedias: true });
    expect(second.mediasMontes).toBe(1);
  });

  it('confirme la soumission une fois tous ses médias montés', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 3));
    await moteur.synchroniser({ inclureMedias: true });

    expect((await magasin.lireSoumission('s1'))?.etat).toBe('confirmee');
  });

  it('sort un média définitivement refusé sans bloquer les autres', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 2));
    const initier = transport.initierMedia.bind(transport);
    transport.initierMedia = async (id, taille, checksum) => {
      if (id === 's1-media-0') {
        throw new ErreurTransport('Média rejeté', false, 'media-refuse');
      }
      return initier(id, taille, checksum);
    };

    const rapport = await moteur.synchroniser({ inclureMedias: true });
    expect(rapport.mediasMontes).toBe(1);

    const medias = await magasin.listerMediasDeSoumission('s1');
    expect(medias.find((m) => m.id === 's1-media-0')?.etat).toBe('echec_permanent');
  });
});

describe('ordre', () => {
  it('envoie le texte avant les médias', async () => {
    // Quelques kilo-octets passent sur un réseau dégradé, une photo non.
    await magasin.finaliserSoumission(aFinaliser('s1', 1));
    const ordre: string[] = [];

    const envoyerLot = transport.envoyerLot.bind(transport);
    transport.envoyerLot = async (soumissions) => {
      ordre.push('texte');
      return envoyerLot(soumissions);
    };
    const initier = transport.initierMedia.bind(transport);
    transport.initierMedia = async (id, taille, checksum) => {
      ordre.push('media');
      return initier(id, taille, checksum);
    };

    await moteur.synchroniser({ inclureMedias: true });
    expect(ordre).toEqual(['texte', 'media']);
  });

  it('ne tente pas les médias si le texte a échoué', async () => {
    await magasin.finaliserSoumission(aFinaliser('s1', 1));
    transport.prochaineErreurLot = new ErreurTransport('Réseau absent', true, 'reseau');

    const rapport = await moteur.synchroniser({ inclureMedias: true });
    expect(rapport.mediasMontes).toBe(0);
    expect(transport.medias.size).toBe(0);
  });
});
