import { SCHEMA_DOCUMENT } from './structure.js';
import { validerRegles, type AnomalieDocument } from './regles.js';
import { VERSION_SCHEMA_COURANTE, type DocumentFormulaire } from './types.js';

export type ResultatValidation =
  | { readonly ok: true; readonly document: DocumentFormulaire }
  | { readonly ok: false; readonly anomalies: readonly AnomalieDocument[] };

/**
 * Valide un document de formulaire de bout en bout : structure puis règles
 * métier.
 *
 * C'est la porte que franchit tout document avant d'être publié — venu du
 * concepteur web, d'un import XLSForm ou d'un appel direct à l'API. Ce qui
 * passe ici est interprétable par l'application agent sans surprise.
 *
 * La validation ne lève jamais : elle rend la liste complète des anomalies,
 * pour que le concepteur les corrige toutes d'un coup plutôt qu'une par
 * publication refusée.
 */
export function validerDocument(brut: unknown): ResultatValidation {
  // La version du format se lit avant tout le reste. Un document produit par
  // une version plus récente contient des constructions que cette application
  // ne connaît pas : les signaler une par une comme des erreurs de structure
  // noierait le seul diagnostic utile, « mettez l'application à jour ».
  const versionTropRecente = lireVersionTropRecente(brut);
  if (versionTropRecente !== null) {
    return { ok: false, anomalies: [versionTropRecente] };
  }

  const structure = SCHEMA_DOCUMENT.safeParse(brut);

  if (!structure.success) {
    return {
      ok: false,
      anomalies: structure.error.issues.map((probleme) => ({
        code: `structure-${probleme.code}`,
        message: probleme.message,
        chemin: probleme.path.map(String),
      })),
    };
  }

  const document = structure.data as unknown as DocumentFormulaire;
  const anomalies = validerRegles(document);

  return anomalies.length > 0 ? { ok: false, anomalies } : { ok: true, document };
}

function lireVersionTropRecente(brut: unknown): AnomalieDocument | null {
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) return null;
  const version = (brut as Record<string, unknown>)['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  if (version <= VERSION_SCHEMA_COURANTE) return null;
  return {
    code: 'version-trop-recente',
    message: `Ce formulaire utilise la version ${version} du format, alors que cette application ne gère que la version ${VERSION_SCHEMA_COURANTE}. Mettez l'application à jour.`,
    chemin: [],
    champ: 'schemaVersion',
  };
}

export { validerRegles } from './regles.js';
export type { AnomalieDocument } from './regles.js';
export { SCHEMA_DOCUMENT } from './structure.js';
export * from './types.js';
