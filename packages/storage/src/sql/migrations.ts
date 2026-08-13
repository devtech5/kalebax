/**
 * Évolution du schéma local — docs/stockage.md §5.
 *
 * Les migrations sont séquentielles et sans saut : un appareil qui revient
 * après six versions les applique toutes, dans l'ordre.
 *
 * **Une migration ne supprime ni ne réécrit jamais une soumission non
 * synchronisée.** Une migration qui perd des données de terrain est un défaut
 * irrécupérable — préférer une colonne en trop, définitivement.
 */
export interface Migration {
  readonly version: number;
  readonly nom: string;
  readonly instructions: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    nom: 'schema-initial',
    instructions: [
      `CREATE TABLE IF NOT EXISTS soumissions (
        id TEXT PRIMARY KEY,
        form_version_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        data TEXT NOT NULL,
        etat TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        device_id TEXT,
        app_version TEXT,
        start_latitude REAL,
        start_longitude REAL,
        start_accuracy REAL,
        start_geopoint_status TEXT,
        statut_serveur TEXT,
        code_echec TEXT,
        message_echec TEXT,
        nombre_tentatives INTEGER NOT NULL DEFAULT 0,
        prochaine_tentative_a TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // La file d'envoi se lit par état et par ancienneté : c'est la requête la
      // plus fréquente de l'application.
      `CREATE INDEX IF NOT EXISTS idx_soumissions_etat
        ON soumissions (etat, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_soumissions_version
        ON soumissions (form_version_id)`,

      `CREATE TABLE IF NOT EXISTS medias (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        question_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        chemin_fichier TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        octets_envoyes INTEGER NOT NULL DEFAULT 0,
        etat TEXT NOT NULL,
        captured_at TEXT,
        latitude REAL,
        longitude REAL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_medias_etat ON medias (etat)`,
      `CREATE INDEX IF NOT EXISTS idx_medias_soumission ON medias (submission_id)`,

      `CREATE TABLE IF NOT EXISTS versions_formulaire (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        schema TEXT NOT NULL,
        status TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS jeux_donnees (
        nom TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        contenu TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS meta (
        cle TEXT PRIMARY KEY,
        valeur TEXT NOT NULL
      )`,
    ],
  },
];

export const VERSION_SCHEMA_LOCAL = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
