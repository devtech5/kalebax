import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { MagasinLocal } from '../port.js';
import type { SoumissionAFinaliser, SoumissionLocale } from '../types.js';

/**
 * Suite de conformité — docs/stockage.md §6.
 *
 * Un jeu de tests unique que chaque adaptateur doit passer. C'est la seule
 * façon de garantir que le mobile, le desktop et le navigateur se comportent
 * à l'identique : sans elle, trois implémentations d'une même règle finissent
 * toujours par diverger, et la divergence se découvre en production, sur les
 * données d'un client.
 *
 * **Un adaptateur qui ne passe pas la suite n'est pas un adaptateur.**
 */
export interface FabriqueMagasin {
  readonly nom: string;
  /** Crée un magasin vierge. Appelée avant chaque test. */
  creer(): Promise<MagasinLocal>;
}

const HORODATAGE = '2026-08-13T09:00:00.000Z';

export function soumissionExemple(
  id: string,
  extra: Partial<SoumissionLocale> = {},
): SoumissionLocale {
  return {
    id,
    formVersionId: 'version-1',
    projectId: 'projet-1',
    data: { nom: 'Boutique Awa', prix: 500 },
    etat: 'brouillon',
    startedAt: HORODATAGE,
    completedAt: null,
    deviceId: 'tecno-spark-8',
    appVersion: '1.0.0',
    startLatitude: 5.333862,
    startLongitude: -4.07025,
    startAccuracy: 12,
    startGeopointStatus: 'captured',
    statutServeur: null,
    codeEchec: null,
    messageEchec: null,
    nombreTentatives: 0,
    prochaineTentativeA: null,
    createdAt: HORODATAGE,
    updatedAt: HORODATAGE,
    ...extra,
  };
}

function aFinaliser(id: string, nombreMedias = 0): SoumissionAFinaliser {
  const base = soumissionExemple(id, { completedAt: '2026-08-13T09:12:00.000Z' });
  return {
    soumission: base,
    medias: Array.from({ length: nombreMedias }, (_, index) => ({
      id: `${id}-media-${index}`,
      submissionId: id,
      questionName: 'photos',
      kind: 'photo' as const,
      cheminFichier: `/media/${id}-${index}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 300_000,
      checksum: 'a'.repeat(64),
      capturedAt: HORODATAGE,
      latitude: 5.333862,
      longitude: -4.07025,
    })),
  };
}

/** Exécute la suite de conformité sur un adaptateur. */
export function verifierConformite(fabrique: FabriqueMagasin): void {
  describe(`conformité — ${fabrique.nom}`, () => {
    let magasin: MagasinLocal;

    beforeEach(async () => {
      magasin = await fabrique.creer();
      await magasin.ouvrir();
    });

    afterEach(async () => {
      await magasin.fermer();
    });

    describe('brouillons', () => {
      it('enregistre et relit un brouillon', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('s1'));
        const relue = await magasin.lireSoumission('s1');
        expect(relue?.data).toEqual({ nom: 'Boutique Awa', prix: 500 });
        expect(relue?.etat).toBe('brouillon');
      });

      it('conserve la position et sa précision', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('s1'));
        const relue = await magasin.lireSoumission('s1');
        expect(relue?.startAccuracy).toBe(12);
        expect(relue?.startGeopointStatus).toBe('captured');
      });

      it('conserve un échec de capture GPS', async () => {
        await magasin.enregistrerBrouillon(
          soumissionExemple('s1', {
            startLatitude: null,
            startLongitude: null,
            startAccuracy: null,
            startGeopointStatus: 'denied',
          }),
        );
        expect((await magasin.lireSoumission('s1'))?.startGeopointStatus).toBe('denied');
      });

      it('remplace un brouillon existant', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('s1'));
        await magasin.enregistrerBrouillon(
          soumissionExemple('s1', { data: { nom: 'Corrigé' } }),
        );
        expect((await magasin.lireSoumission('s1'))?.data).toEqual({ nom: 'Corrigé' });
        expect(await magasin.listerBrouillons()).toHaveLength(1);
      });

      it('rend null pour une soumission inconnue', async () => {
        expect(await magasin.lireSoumission('jamais-vue')).toBeNull();
      });

      it('supprime un brouillon', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('s1'));
        await magasin.supprimerBrouillon('s1');
        expect(await magasin.lireSoumission('s1')).toBeNull();
      });
    });

    describe('finalisation', () => {
      it('met la soumission en file', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        const enFile = await magasin.listerAEnvoyer(10);
        expect(enFile.map((s) => s.id)).toEqual(['s1']);
        expect(enFile[0]?.etat).toBe('en_attente');
      });

      it('écrit la soumission et ses médias d\'un bloc', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 3));
        expect(await magasin.listerMediasDeSoumission('s1')).toHaveLength(3);
        expect((await magasin.listerMediasAEnvoyer(10))).toHaveLength(3);
      });

      it('refuse de modifier une soumission finalisée', async () => {
        // Toute correction passe par la console d'un superviseur, qui crée une
        // révision attribuée.
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.enregistrerBrouillon(
          soumissionExemple('s1', { data: { nom: 'Falsifié' } }),
        );

        const relue = await magasin.lireSoumission('s1');
        expect(relue?.etat).toBe('en_attente');
        expect(relue?.data).toEqual({ nom: 'Boutique Awa', prix: 500 });
      });

      it('ne supprime pas une soumission finalisée', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.supprimerBrouillon('s1');
        expect(await magasin.lireSoumission('s1')).not.toBeNull();
      });

      it('finalise deux fois sans dupliquer les médias', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 2));
        await magasin.finaliserSoumission(aFinaliser('s1', 2));
        expect(await magasin.listerMediasDeSoumission('s1')).toHaveLength(2);
      });
    });

    describe('file d\'envoi', () => {
      it('respecte l\'ordre d\'arrivée', async () => {
        for (const id of ['s1', 's2', 's3']) {
          await magasin.finaliserSoumission({
            ...aFinaliser(id),
            soumission: soumissionExemple(id, {
              createdAt: `2026-08-1${id.slice(1)}T09:00:00.000Z`,
            }),
          });
        }
        const enFile = await magasin.listerAEnvoyer(10);
        expect(enFile.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
      });

      it('respecte la limite demandée', async () => {
        for (const id of ['s1', 's2', 's3']) {
          await magasin.finaliserSoumission(aFinaliser(id));
        }
        expect(await magasin.listerAEnvoyer(2)).toHaveLength(2);
      });

      it('marque les soumissions envoyées', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.marquerEnvoyees(['s1']);
        expect((await magasin.lireSoumission('s1'))?.etat).toBe('envoyee');
      });

      it('garde en file une soumission envoyée sans accusé', async () => {
        // La réponse peut s'être perdue dans la coupure : l'appareil rejoue, et
        // l'idempotence côté serveur évite le doublon.
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.marquerEnvoyees(['s1']);
        expect(await magasin.listerAEnvoyer(10)).toHaveLength(1);
      });

      it('ignore une liste vide sans erreur', async () => {
        await expect(magasin.marquerEnvoyees([])).resolves.toBeUndefined();
      });
    });

    describe('confirmation', () => {
      it('confirme une soumission sans média', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.confirmerSoumission('s1', 'received');

        const relue = await magasin.lireSoumission('s1');
        expect(relue?.etat).toBe('confirmee');
        expect(relue?.statutServeur).toBe('received');
        expect(await magasin.listerAEnvoyer(10)).toHaveLength(0);
      });

      it('traite un rejet serveur comme un accusé', async () => {
        // La donnée est enregistrée côté serveur avec ses violations, pour
        // arbitrage humain : ce n'est pas un échec de transmission.
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.confirmerSoumission('s1', 'rejected');

        const relue = await magasin.lireSoumission('s1');
        expect(relue?.etat).toBe('confirmee');
        expect(relue?.statutServeur).toBe('rejected');
      });

      it('attend les médias avant de confirmer', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 2));
        await magasin.confirmerSoumission('s1', 'received');
        expect((await magasin.lireSoumission('s1'))?.etat).toBe('medias_en_attente');
      });

      it('confirme une fois le dernier média monté', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 2));
        await magasin.confirmerSoumission('s1', 'received');

        await magasin.marquerMediaMonte('s1-media-0');
        expect((await magasin.lireSoumission('s1'))?.etat).toBe('medias_en_attente');

        await magasin.marquerMediaMonte('s1-media-1');
        expect((await magasin.lireSoumission('s1'))?.etat).toBe('confirmee');
      });
    });

    describe('échecs', () => {
      it('sort de la file une soumission en échec permanent', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.marquerEchecPermanent('s1', 'version-inconnue', 'Version absente');

        expect(await magasin.listerAEnvoyer(10)).toHaveLength(0);
        const relue = await magasin.lireSoumission('s1');
        expect(relue?.etat).toBe('echec_permanent');
        expect(relue?.codeEchec).toBe('version-inconnue');
      });

      it('ne supprime jamais une soumission en échec', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.marquerEchecPermanent('s1', 'version-inconnue', 'Version absente');
        expect(await magasin.lireSoumission('s1')).not.toBeNull();
      });

      it('ne laisse pas un échec bloquer la file', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.finaliserSoumission(aFinaliser('s2'));
        await magasin.marquerEchecPermanent('s1', 'version-inconnue', 'Version absente');

        expect((await magasin.listerAEnvoyer(10)).map((s) => s.id)).toEqual(['s2']);
      });

      it('reporte une tentative sans perdre la soumission', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.marquerEnvoyees(['s1']);
        const plusTard = new Date(Date.now() + 60_000);
        await magasin.reporterTentative('s1', plusTard);

        const relue = await magasin.lireSoumission('s1');
        expect(relue?.etat).toBe('en_attente');
        expect(relue?.nombreTentatives).toBe(1);
      });

      it('ne remonte pas une soumission dont le délai n\'est pas écoulé', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.reporterTentative('s1', new Date(Date.now() + 3_600_000));

        expect(await magasin.listerAEnvoyer(10)).toHaveLength(0);
        expect(
          await magasin.listerAEnvoyer(10, new Date(Date.now() + 7_200_000)),
        ).toHaveLength(1);
      });
    });

    describe('médias', () => {
      it('enregistre la progression d\'un envoi', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.enregistrerProgressionMedia('s1-media-0', 180_000);

        const medias = await magasin.listerMediasDeSoumission('s1');
        expect(medias[0]?.octetsEnvoyes).toBe(180_000);
        expect(medias[0]?.etat).toBe('en_cours');
      });

      it('garde un média entamé dans la file', async () => {
        // Une coupure à 60 % reprend à 60 %, elle ne recommence pas.
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.enregistrerProgressionMedia('s1-media-0', 180_000);
        expect(await magasin.listerMediasAEnvoyer(10)).toHaveLength(1);
      });

      it('sort un média monté de la file', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.marquerMediaMonte('s1-media-0');
        expect(await magasin.listerMediasAEnvoyer(10)).toHaveLength(0);
      });

      it('sort un média en échec de la file', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.marquerMediaEchec('s1-media-0');
        expect(await magasin.listerMediasAEnvoyer(10)).toHaveLength(0);
      });
    });

    describe('comptes visibles par l\'agent', () => {
      it('compte les soumissions par état', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('b1'));
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.finaliserSoumission(aFinaliser('s2'));
        await magasin.confirmerSoumission('s2', 'received');

        const comptes = await magasin.compterParEtat();
        expect(comptes.brouillon).toBe(1);
        expect(comptes.en_attente).toBe(1);
        expect(comptes.confirmee).toBe(1);
        expect(comptes.echec_permanent).toBe(0);
      });
    });

    describe('versions de formulaire', () => {
      const version = {
        id: 'version-1',
        formId: 'form-1',
        versionNumber: 1,
        schema: { schemaVersion: 1, children: [] },
        status: 'published',
      };

      it('enregistre et relit une version', async () => {
        await magasin.enregistrerVersionFormulaire(version);
        expect((await magasin.lireVersionFormulaire('version-1'))?.schema).toEqual(
          version.schema,
        );
      });

      it('remplace une version existante', async () => {
        await magasin.enregistrerVersionFormulaire(version);
        await magasin.enregistrerVersionFormulaire({ ...version, status: 'retired' });

        expect(await magasin.listerVersionsFormulaire()).toHaveLength(1);
        expect((await magasin.lireVersionFormulaire('version-1'))?.status).toBe('retired');
      });

      it('garde une version référencée par une soumission', async () => {
        // Sinon la donnée deviendrait ininterprétable avant même d'être partie.
        await magasin.enregistrerVersionFormulaire(version);
        await magasin.finaliserSoumission(aFinaliser('s1'));

        expect(await magasin.purgerVersionsInutilisees()).toBe(0);
        expect(await magasin.listerVersionsFormulaire()).toHaveLength(1);
      });

      it('purge une version que plus rien ne référence', async () => {
        await magasin.enregistrerVersionFormulaire({ ...version, id: 'version-orpheline' });
        expect(await magasin.purgerVersionsInutilisees()).toBe(1);
      });
    });

    describe('référentiels', () => {
      it('enregistre et relit un jeu de données', async () => {
        await magasin.enregistrerJeuDonnees({
          nom: 'points_vente',
          version: 12,
          contenu: [{ value: 'pv-1', label: 'Boutique du marché' }],
        });

        const relu = await magasin.lireJeuDonnees('points_vente');
        expect(relu?.version).toBe(12);
        expect(relu?.contenu).toEqual([{ value: 'pv-1', label: 'Boutique du marché' }]);
      });

      it('rend les versions détenues, pour le différentiel', async () => {
        await magasin.enregistrerJeuDonnees({ nom: 'points_vente', version: 12, contenu: [] });
        await magasin.enregistrerJeuDonnees({ nom: 'localites', version: 4, contenu: [] });

        expect(await magasin.versionsJeuxDonnees()).toEqual({
          points_vente: 12,
          localites: 4,
        });
      });

      it('remplace un référentiel par sa version plus récente', async () => {
        await magasin.enregistrerJeuDonnees({ nom: 'points_vente', version: 12, contenu: [] });
        await magasin.enregistrerJeuDonnees({ nom: 'points_vente', version: 15, contenu: ['x'] });

        const relu = await magasin.lireJeuDonnees('points_vente');
        expect(relu?.version).toBe(15);
      });
    });

    describe('purge', () => {
      it('supprime les soumissions confirmées anciennes', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.confirmerSoumission('s1', 'received');

        const demain = new Date(Date.now() + 86_400_000);
        expect(await magasin.purgerConfirmeesAvant(demain)).toBe(1);
        expect(await magasin.lireSoumission('s1')).toBeNull();
      });

      it('épargne une soumission qui attend encore ses médias', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.confirmerSoumission('s1', 'received');

        const demain = new Date(Date.now() + 86_400_000);
        expect(await magasin.purgerConfirmeesAvant(demain)).toBe(0);
        expect(await magasin.lireSoumission('s1')).not.toBeNull();
      });

      it('épargne tout ce qui n\'est pas confirmé', async () => {
        await magasin.enregistrerBrouillon(soumissionExemple('b1'));
        await magasin.finaliserSoumission(aFinaliser('s1'));
        await magasin.finaliserSoumission(aFinaliser('s2'));
        await magasin.marquerEchecPermanent('s2', 'version-inconnue', 'Absente');

        const demain = new Date(Date.now() + 86_400_000);
        expect(await magasin.purgerConfirmeesAvant(demain)).toBe(0);
        expect((await magasin.compterParEtat()).echec_permanent).toBe(1);
      });

      it('supprime aussi les médias de la soumission purgée', async () => {
        await magasin.finaliserSoumission(aFinaliser('s1', 2));
        await magasin.confirmerSoumission('s1', 'received');
        await magasin.marquerMediaMonte('s1-media-0');
        await magasin.marquerMediaMonte('s1-media-1');

        await magasin.purgerConfirmeesAvant(new Date(Date.now() + 86_400_000));
        expect(await magasin.listerMediasDeSoumission('s1')).toHaveLength(0);
      });
    });

    describe('clé-valeur', () => {
      it('écrit et relit une valeur', async () => {
        await magasin.ecrireMeta('derniere_sync', HORODATAGE);
        expect(await magasin.lireMeta('derniere_sync')).toBe(HORODATAGE);
      });

      it('remplace une valeur existante', async () => {
        await magasin.ecrireMeta('derniere_sync', HORODATAGE);
        await magasin.ecrireMeta('derniere_sync', '2026-08-14T10:00:00.000Z');
        expect(await magasin.lireMeta('derniere_sync')).toBe('2026-08-14T10:00:00.000Z');
      });

      it('rend null pour une clé absente', async () => {
        expect(await magasin.lireMeta('jamais_ecrite')).toBeNull();
      });
    });

    describe('réouverture', () => {
      it('supporte une seconde ouverture sans perdre de données', async () => {
        // C'est ce qui se passe après une extinction brutale : le magasin est
        // rouvert, les migrations rejouées, et rien ne doit disparaître.
        await magasin.finaliserSoumission(aFinaliser('s1', 1));
        await magasin.ouvrir();

        expect(await magasin.lireSoumission('s1')).not.toBeNull();
        expect(await magasin.listerMediasDeSoumission('s1')).toHaveLength(1);
      });
    });
  });
}
