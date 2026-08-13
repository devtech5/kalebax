import type { MagasinLocal } from '../port.js';
import type {
  ComptesParEtat,
  EtatSoumission,
  JeuDonneesLocal,
  MediaLocal,
  SoumissionAFinaliser,
  SoumissionLocale,
  VersionFormulaireLocale,
} from '../types.js';
import { ETATS_SOUMISSION } from '../types.js';
import { MIGRATIONS } from './migrations.js';
import { CHIFFREUR_TRANSPARENT, type Chiffreur, type PiloteSql } from './pilote.js';

/** Ligne telle que SQLite la rend : que des scalaires. */
interface LigneSoumission {
  id: string;
  form_version_id: string;
  project_id: string;
  data: string;
  etat: string;
  started_at: string;
  completed_at: string | null;
  device_id: string | null;
  app_version: string | null;
  start_latitude: number | null;
  start_longitude: number | null;
  start_accuracy: number | null;
  start_geopoint_status: string | null;
  statut_serveur: string | null;
  code_echec: string | null;
  message_echec: string | null;
  nombre_tentatives: number;
  prochaine_tentative_a: string | null;
  created_at: string;
  updated_at: string;
}

interface LigneMedia {
  id: string;
  submission_id: string;
  question_name: string;
  kind: string;
  chemin_fichier: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  octets_envoyes: number;
  etat: string;
  captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * L'implémentation du stockage local, unique pour les quatre moteurs SQLite.
 *
 * Voir docs/stockage.md §2.1 : ce qui diffère d'une cible à l'autre est la
 * façon d'exécuter du SQL, pas le SQL lui-même.
 */
export class MagasinSql implements MagasinLocal {
  constructor(
    private readonly pilote: PiloteSql,
    private readonly chiffreur: Chiffreur = CHIFFREUR_TRANSPARENT,
  ) {}

  async ouvrir(): Promise<void> {
    await this.pilote.executer(
      `CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        nom TEXT NOT NULL,
        appliquee_a TEXT NOT NULL
      )`,
    );

    const appliquees = await this.pilote.interroger<{ version: number }>(
      'SELECT version FROM migrations',
    );
    const connues = new Set(appliquees.map((ligne) => ligne.version));

    // Séquentielles et sans saut : un appareil qui revient après six versions
    // les applique toutes, dans l'ordre.
    for (const migration of MIGRATIONS) {
      if (connues.has(migration.version)) continue;
      for (const instruction of migration.instructions) {
        await this.pilote.executer(instruction);
      }
      await this.pilote.executer(
        'INSERT INTO migrations (version, nom, appliquee_a) VALUES (?, ?, ?)',
        [migration.version, migration.nom, new Date().toISOString()],
      );
    }
  }

  async fermer(): Promise<void> {
    await this.pilote.fermer();
  }

  /* ------------------------------------------------------- brouillons */

  async enregistrerBrouillon(soumission: SoumissionLocale): Promise<void> {
    const existante = await this.lireSoumission(soumission.id);
    // Une soumission finalisée n'est plus modifiable sur l'appareil : toute
    // correction passe par la console d'un superviseur.
    if (existante !== null && existante.etat !== 'brouillon') return;

    await this.pilote.executer(
      `INSERT INTO soumissions (
        id, form_version_id, project_id, data, etat, started_at, completed_at,
        device_id, app_version, start_latitude, start_longitude, start_accuracy,
        start_geopoint_status, statut_serveur, code_echec, message_echec,
        nombre_tentatives, prochaine_tentative_a, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        completed_at = excluded.completed_at,
        start_latitude = excluded.start_latitude,
        start_longitude = excluded.start_longitude,
        start_accuracy = excluded.start_accuracy,
        start_geopoint_status = excluded.start_geopoint_status,
        updated_at = excluded.updated_at`,
      [
        soumission.id,
        soumission.formVersionId,
        soumission.projectId,
        this.chiffreur.chiffrer(JSON.stringify(soumission.data)),
        'brouillon',
        soumission.startedAt,
        soumission.completedAt,
        soumission.deviceId,
        soumission.appVersion,
        soumission.startLatitude,
        soumission.startLongitude,
        soumission.startAccuracy,
        soumission.startGeopointStatus,
        null,
        null,
        null,
        0,
        null,
        soumission.createdAt,
        soumission.updatedAt,
      ],
    );
  }

  async lireSoumission(id: string): Promise<SoumissionLocale | null> {
    const lignes = await this.pilote.interroger<LigneSoumission>(
      'SELECT * FROM soumissions WHERE id = ?',
      [id],
    );
    const ligne = lignes[0];
    return ligne === undefined ? null : this.versSoumission(ligne);
  }

  async listerBrouillons(): Promise<SoumissionLocale[]> {
    return this.listerParEtat('brouillon');
  }

  async supprimerBrouillon(id: string): Promise<void> {
    // La clause sur l'état est la garantie : rien de finalisé ne disparaît,
    // même si l'appelant se trompe d'identifiant.
    await this.pilote.executer(
      "DELETE FROM soumissions WHERE id = ? AND etat = 'brouillon'",
      [id],
    );
    await this.pilote.executer('DELETE FROM medias WHERE submission_id = ?', [id]);
  }

  /* -------------------------------------------------------- file d'envoi */

  async finaliserSoumission(entree: SoumissionAFinaliser): Promise<void> {
    const { soumission, medias } = entree;
    const maintenant = new Date().toISOString();

    await this.pilote.enBloc(async () => {
      await this.pilote.executer(
        `INSERT INTO soumissions (
          id, form_version_id, project_id, data, etat, started_at, completed_at,
          device_id, app_version, start_latitude, start_longitude, start_accuracy,
          start_geopoint_status, statut_serveur, code_echec, message_echec,
          nombre_tentatives, prochaine_tentative_a, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          etat = 'en_attente',
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at`,
        [
          soumission.id,
          soumission.formVersionId,
          soumission.projectId,
          this.chiffreur.chiffrer(JSON.stringify(soumission.data)),
          'en_attente',
          soumission.startedAt,
          soumission.completedAt,
          soumission.deviceId,
          soumission.appVersion,
          soumission.startLatitude,
          soumission.startLongitude,
          soumission.startAccuracy,
          soumission.startGeopointStatus,
          null,
          null,
          null,
          0,
          null,
          maintenant,
          maintenant,
        ],
      );

      for (const media of medias) {
        await this.pilote.executer(
          `INSERT INTO medias (
            id, submission_id, question_name, kind, chemin_fichier, mime_type,
            size_bytes, checksum, octets_envoyes, etat, captured_at, latitude, longitude
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO NOTHING`,
          [
            media.id,
            media.submissionId,
            media.questionName,
            media.kind,
            media.cheminFichier,
            media.mimeType,
            media.sizeBytes,
            media.checksum,
            0,
            'a_envoyer',
            media.capturedAt,
            media.latitude,
            media.longitude,
          ],
        );
      }
    });
  }

  async listerAEnvoyer(limite: number, maintenant = new Date()): Promise<SoumissionLocale[]> {
    const lignes = await this.pilote.interroger<LigneSoumission>(
      `SELECT * FROM soumissions
       WHERE etat IN ('en_attente', 'envoyee')
         AND (prochaine_tentative_a IS NULL OR prochaine_tentative_a <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [maintenant.toISOString(), limite],
    );
    return lignes.map((ligne) => this.versSoumission(ligne));
  }

  async marquerEnvoyees(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const trous = ids.map(() => '?').join(',');
    await this.pilote.executer(
      `UPDATE soumissions
       SET etat = 'envoyee', updated_at = ?
       WHERE id IN (${trous}) AND etat = 'en_attente'`,
      [new Date().toISOString(), ...ids],
    );
  }

  async confirmerSoumission(id: string, statutServeur: string): Promise<void> {
    await this.pilote.enBloc(async () => {
      const restants = await this.pilote.interroger<{ nombre: number }>(
        "SELECT COUNT(*) AS nombre FROM medias WHERE submission_id = ? AND etat != 'monte'",
        [id],
      );
      // Une soumission qui attend encore ses pièces jointes n'est pas
      // confirmée : elle survivra à la purge.
      const etat: EtatSoumission =
        (restants[0]?.nombre ?? 0) > 0 ? 'medias_en_attente' : 'confirmee';

      await this.pilote.executer(
        `UPDATE soumissions
         SET etat = ?, statut_serveur = ?, code_echec = NULL, message_echec = NULL,
             prochaine_tentative_a = NULL, updated_at = ?
         WHERE id = ?`,
        [etat, statutServeur, new Date().toISOString(), id],
      );
    });
  }

  async marquerEchecPermanent(id: string, code: string, message: string): Promise<void> {
    await this.pilote.executer(
      `UPDATE soumissions
       SET etat = 'echec_permanent', code_echec = ?, message_echec = ?, updated_at = ?
       WHERE id = ?`,
      [code, message, new Date().toISOString(), id],
    );
  }

  async reporterTentative(id: string, prochaineTentativeA: Date): Promise<void> {
    await this.pilote.executer(
      `UPDATE soumissions
       SET etat = 'en_attente',
           nombre_tentatives = nombre_tentatives + 1,
           prochaine_tentative_a = ?,
           updated_at = ?
       WHERE id = ?`,
      [prochaineTentativeA.toISOString(), new Date().toISOString(), id],
    );
  }

  async listerParEtat(etat: EtatSoumission, limite = 1000): Promise<SoumissionLocale[]> {
    const lignes = await this.pilote.interroger<LigneSoumission>(
      'SELECT * FROM soumissions WHERE etat = ? ORDER BY created_at ASC LIMIT ?',
      [etat, limite],
    );
    return lignes.map((ligne) => this.versSoumission(ligne));
  }

  async compterParEtat(): Promise<ComptesParEtat> {
    const lignes = await this.pilote.interroger<{ etat: string; nombre: number }>(
      'SELECT etat, COUNT(*) AS nombre FROM soumissions GROUP BY etat',
    );
    const comptes = Object.fromEntries(
      ETATS_SOUMISSION.map((etat) => [etat, 0]),
    ) as Record<EtatSoumission, number>;
    for (const ligne of lignes) {
      comptes[ligne.etat as EtatSoumission] = Number(ligne.nombre);
    }
    return comptes;
  }

  /* ------------------------------------------------------------ médias */

  async listerMediasAEnvoyer(limite: number): Promise<MediaLocal[]> {
    const lignes = await this.pilote.interroger<LigneMedia>(
      `SELECT * FROM medias WHERE etat IN ('a_envoyer', 'en_cours') LIMIT ?`,
      [limite],
    );
    return lignes.map(versMedia);
  }

  async listerMediasDeSoumission(submissionId: string): Promise<MediaLocal[]> {
    const lignes = await this.pilote.interroger<LigneMedia>(
      'SELECT * FROM medias WHERE submission_id = ?',
      [submissionId],
    );
    return lignes.map(versMedia);
  }

  async enregistrerProgressionMedia(id: string, octetsEnvoyes: number): Promise<void> {
    await this.pilote.executer(
      "UPDATE medias SET octets_envoyes = ?, etat = 'en_cours' WHERE id = ?",
      [octetsEnvoyes, id],
    );
  }

  async marquerMediaMonte(id: string): Promise<void> {
    await this.pilote.enBloc(async () => {
      await this.pilote.executer(
        `UPDATE medias
         SET etat = 'monte', octets_envoyes = size_bytes
         WHERE id = ?`,
        [id],
      );

      // La soumission qui n'attendait plus que ce média passe confirmée.
      await this.pilote.executer(
        `UPDATE soumissions
         SET etat = 'confirmee', updated_at = ?
         WHERE etat = 'medias_en_attente'
           AND id = (SELECT submission_id FROM medias WHERE id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM medias m
             WHERE m.submission_id = soumissions.id AND m.etat != 'monte'
           )`,
        [new Date().toISOString(), id],
      );
    });
  }

  async marquerMediaEchec(id: string): Promise<void> {
    await this.pilote.executer("UPDATE medias SET etat = 'echec_permanent' WHERE id = ?", [
      id,
    ]);
  }

  /* ------------------------------------------------------- formulaires */

  async enregistrerVersionFormulaire(version: VersionFormulaireLocale): Promise<void> {
    await this.pilote.executer(
      `INSERT INTO versions_formulaire (id, form_id, version_number, schema, status)
       VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         schema = excluded.schema,
         status = excluded.status`,
      [
        version.id,
        version.formId,
        version.versionNumber,
        JSON.stringify(version.schema),
        version.status,
      ],
    );
  }

  async lireVersionFormulaire(id: string): Promise<VersionFormulaireLocale | null> {
    const lignes = await this.pilote.interroger<{
      id: string;
      form_id: string;
      version_number: number;
      schema: string;
      status: string;
    }>('SELECT * FROM versions_formulaire WHERE id = ?', [id]);
    const ligne = lignes[0];
    if (ligne === undefined) return null;
    return {
      id: ligne.id,
      formId: ligne.form_id,
      versionNumber: ligne.version_number,
      schema: JSON.parse(ligne.schema) as unknown,
      status: ligne.status,
    };
  }

  async listerVersionsFormulaire(): Promise<VersionFormulaireLocale[]> {
    const lignes = await this.pilote.interroger<{
      id: string;
      form_id: string;
      version_number: number;
      schema: string;
      status: string;
    }>('SELECT * FROM versions_formulaire ORDER BY form_id, version_number');
    return lignes.map((ligne) => ({
      id: ligne.id,
      formId: ligne.form_id,
      versionNumber: ligne.version_number,
      schema: JSON.parse(ligne.schema) as unknown,
      status: ligne.status,
    }));
  }

  async purgerVersionsInutilisees(): Promise<number> {
    const avant = await this.pilote.interroger<{ nombre: number }>(
      'SELECT COUNT(*) AS nombre FROM versions_formulaire',
    );
    await this.pilote.executer(
      `DELETE FROM versions_formulaire
       WHERE id NOT IN (SELECT DISTINCT form_version_id FROM soumissions)`,
    );
    const apres = await this.pilote.interroger<{ nombre: number }>(
      'SELECT COUNT(*) AS nombre FROM versions_formulaire',
    );
    return Number(avant[0]?.nombre ?? 0) - Number(apres[0]?.nombre ?? 0);
  }

  /* -------------------------------------------------------- référentiels */

  async enregistrerJeuDonnees(jeu: JeuDonneesLocal): Promise<void> {
    await this.pilote.executer(
      `INSERT INTO jeux_donnees (nom, version, contenu) VALUES (?,?,?)
       ON CONFLICT(nom) DO UPDATE SET version = excluded.version, contenu = excluded.contenu`,
      [jeu.nom, jeu.version, this.chiffreur.chiffrer(JSON.stringify(jeu.contenu))],
    );
  }

  async lireJeuDonnees(nom: string): Promise<JeuDonneesLocal | null> {
    const lignes = await this.pilote.interroger<{
      nom: string;
      version: number;
      contenu: string;
    }>('SELECT * FROM jeux_donnees WHERE nom = ?', [nom]);
    const ligne = lignes[0];
    if (ligne === undefined) return null;
    return {
      nom: ligne.nom,
      version: ligne.version,
      contenu: JSON.parse(this.chiffreur.dechiffrer(ligne.contenu)) as unknown,
    };
  }

  async versionsJeuxDonnees(): Promise<Record<string, number>> {
    const lignes = await this.pilote.interroger<{ nom: string; version: number }>(
      'SELECT nom, version FROM jeux_donnees',
    );
    return Object.fromEntries(lignes.map((ligne) => [ligne.nom, ligne.version]));
  }

  /* --------------------------------------------------------------- purge */

  async purgerConfirmeesAvant(date: Date): Promise<number> {
    const aPurger = await this.pilote.interroger<{ id: string }>(
      "SELECT id FROM soumissions WHERE etat = 'confirmee' AND updated_at < ?",
      [date.toISOString()],
    );
    if (aPurger.length === 0) return 0;

    const trous = aPurger.map(() => '?').join(',');
    const ids = aPurger.map((ligne) => ligne.id);
    await this.pilote.enBloc(async () => {
      await this.pilote.executer(`DELETE FROM medias WHERE submission_id IN (${trous})`, ids);
      await this.pilote.executer(`DELETE FROM soumissions WHERE id IN (${trous})`, ids);
    });
    return aPurger.length;
  }

  /* ---------------------------------------------------------- clé-valeur */

  async lireMeta(cle: string): Promise<string | null> {
    const lignes = await this.pilote.interroger<{ valeur: string }>(
      'SELECT valeur FROM meta WHERE cle = ?',
      [cle],
    );
    return lignes[0]?.valeur ?? null;
  }

  async ecrireMeta(cle: string, valeur: string): Promise<void> {
    await this.pilote.executer(
      `INSERT INTO meta (cle, valeur) VALUES (?,?)
       ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`,
      [cle, valeur],
    );
  }

  private versSoumission(ligne: LigneSoumission): SoumissionLocale {
    return {
      id: ligne.id,
      formVersionId: ligne.form_version_id,
      projectId: ligne.project_id,
      data: JSON.parse(this.chiffreur.dechiffrer(ligne.data)) as Record<string, unknown>,
      etat: ligne.etat as EtatSoumission,
      startedAt: ligne.started_at,
      completedAt: ligne.completed_at,
      deviceId: ligne.device_id,
      appVersion: ligne.app_version,
      startLatitude: ligne.start_latitude,
      startLongitude: ligne.start_longitude,
      startAccuracy: ligne.start_accuracy,
      startGeopointStatus: ligne.start_geopoint_status as SoumissionLocale['startGeopointStatus'],
      statutServeur: ligne.statut_serveur,
      codeEchec: ligne.code_echec,
      messageEchec: ligne.message_echec,
      nombreTentatives: Number(ligne.nombre_tentatives),
      prochaineTentativeA: ligne.prochaine_tentative_a,
      createdAt: ligne.created_at,
      updatedAt: ligne.updated_at,
    };
  }
}

function versMedia(ligne: LigneMedia): MediaLocal {
  return {
    id: ligne.id,
    submissionId: ligne.submission_id,
    questionName: ligne.question_name,
    kind: ligne.kind as MediaLocal['kind'],
    cheminFichier: ligne.chemin_fichier,
    mimeType: ligne.mime_type,
    sizeBytes: Number(ligne.size_bytes),
    checksum: ligne.checksum,
    octetsEnvoyes: Number(ligne.octets_envoyes),
    etat: ligne.etat as MediaLocal['etat'],
    capturedAt: ligne.captured_at,
    latitude: ligne.latitude,
    longitude: ligne.longitude,
  };
}
