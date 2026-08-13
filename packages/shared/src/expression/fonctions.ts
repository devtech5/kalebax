import type { ContexteEvaluation } from './contexte.js';
import type { ValeurExpression } from './valeur.js';

export interface DefinitionFonction {
  readonly ariteMin: number;
  /** `null` pour une arité variable non bornée. */
  readonly ariteMax: number | null;
  readonly appliquer: (
    args: readonly ValeurExpression[],
    contexte: ContexteEvaluation,
  ) => ValeurExpression;
}

/* ------------------------------------------------------------------ outils */

function estNombre(v: ValeurExpression): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function estChaine(v: ValeurExpression): v is string {
  return typeof v === 'string';
}

function enTableau(v: ValeurExpression): readonly ValeurExpression[] | null {
  if (v === null) return null;
  return Array.isArray(v) ? v : [v];
}

/** Un résultat non fini (division par zéro, débordement) n'existe pas : c'est `null` (§6.3). */
function fini(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

const NOMBRE_STRICT = /^-?\d+(\.\d+)?$/;

/* -------------------------------------------------------------------- dates */

const DATE_SEULE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_HEURE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

interface DateAnalysee {
  readonly ms: number;
  readonly annee: number;
  readonly mois: number;
  readonly jour: number;
}

/**
 * Analyse stricte d'une date ISO 8601. Aucune tolérance : « 13/08/2026 » n'est
 * pas une date pour l'évaluateur, et le 31 février non plus (§6.5).
 */
function analyserDate(v: ValeurExpression): DateAnalysee | null {
  if (!estChaine(v)) return null;

  const seule = DATE_SEULE.exec(v);
  const heure = seule ? null : DATE_HEURE.exec(v);
  const source = seule ?? heure;
  if (source === null) return null;

  const annee = Number(source[1]);
  const mois = Number(source[2]);
  const jour = Number(source[3]);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;

  // Une date-heure sans fuseau explicite est interprétée en heure locale par
  // JavaScript. Ce serait une divergence entre le téléphone d'un agent et le
  // serveur : on force UTC dans ce cas.
  let texte: string;
  if (seule) {
    texte = `${v}T00:00:00.000Z`;
  } else {
    texte = source[9] === undefined ? `${v.replace(' ', 'T')}Z` : v.replace(' ', 'T');
  }

  const ms = Date.parse(texte);
  if (Number.isNaN(ms)) return null;

  // Rejette les jours qui n'existent pas : Date.parse décale le 2026-02-31.
  const reference = new Date(ms);
  if (seule && reference.getUTCDate() !== jour) return null;

  return { ms, annee, mois, jour };
}

/** Différence en mois calendaires, tronquée vers zéro. */
function differenceMois(a: DateAnalysee, b: DateAnalysee): number {
  let mois = (b.annee - a.annee) * 12 + (b.mois - a.mois);
  if (mois > 0 && b.jour < a.jour) mois -= 1;
  else if (mois < 0 && b.jour > a.jour) mois += 1;
  return mois;
}

/* ---------------------------------------------------------------- fonctions */

export const FONCTIONS: Readonly<Record<string, DefinitionFonction>> = {
  /* -- logique -- */

  not: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([a]) => {
      if (a === null || a === undefined) return null;
      return typeof a === 'boolean' ? !a : null;
    },
  },

  // Les deux branches sont déjà évaluées par l'appelant : le langage n'a pas
  // d'effet de bord, donc aucune différence n'est observable, et le budget
  // d'exécution compte les deux (§6.1).
  if: {
    ariteMin: 3,
    ariteMax: 3,
    appliquer: ([cond, siVrai, siFaux]) =>
      cond === true ? (siVrai ?? null) : (siFaux ?? null),
  },

  coalesce: {
    ariteMin: 2,
    ariteMax: null,
    appliquer: (args) => {
      for (const a of args) {
        if (a !== null) return a;
      }
      return null;
    },
  },

  /* -- sélections -- */

  // Une case non cochée est une réponse, pas une absence de réponse : `null`
  // donne donc `false` et non `null` (§6.2).
  selected: {
    ariteMin: 2,
    ariteMax: 2,
    appliquer: ([champ, valeur]) => {
      if (champ === null || champ === undefined || valeur === undefined) return false;
      if (Array.isArray(champ)) return champ.some((v) => v === valeur);
      return champ === valeur;
    },
  },

  'count-selected': {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([champ]) => {
      if (champ === null || champ === undefined) return 0;
      return Array.isArray(champ) ? champ.length : 1;
    },
  },

  count: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([champ]) => {
      if (champ === null || champ === undefined) return 0;
      return Array.isArray(champ) ? champ.length : 1;
    },
  },

  position: {
    ariteMin: 0,
    ariteMax: 0,
    appliquer: (_args, contexte) => contexte.position ?? null,
  },

  /* -- nombres -- */

  // `sum` ignore les valeurs manquantes alors que `+` les propage : il agrège
  // une colonne de groupe répétable, où les occurrences non remplies sont
  // normales (§6.3).
  sum: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([champ]) => {
      const elements = enTableau(champ ?? null);
      if (elements === null) return 0;
      let total = 0;
      for (const e of elements) {
        if (e === null) continue;
        if (!estNombre(e)) return null;
        total += e;
      }
      return fini(total);
    },
  },

  min: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([champ]) => extremum(champ ?? null, 'min'),
  },

  max: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([champ]) => extremum(champ ?? null, 'max'),
  },

  // Math.round arrondit déjà « au plus proche, moitié vers le haut » :
  // round(2.5) = 3 et round(-2.5) = -2, exactement la règle du §6.3.
  round: {
    ariteMin: 1,
    ariteMax: 2,
    appliquer: ([x, decimales]) => {
      if (!estNombre(x ?? null)) return null;
      let n = 0;
      if (decimales !== undefined && decimales !== null) {
        if (!estNombre(decimales)) return null;
        n = Math.trunc(decimales);
        if (n < 0 || n > 15) return null;
      }
      const facteur = 10 ** n;
      return fini(Math.round((x as number) * facteur) / facteur);
    },
  },

  /** Troncature vers zéro, pas un arrondi : int(-2.7) = -2. */
  int: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([x]) => (estNombre(x ?? null) ? Math.trunc(x as number) : null),
  },

  number: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([x]) => {
      if (x === null || x === undefined) return null;
      if (typeof x === 'boolean') return x ? 1 : 0;
      if (estNombre(x)) return x;
      if (estChaine(x)) {
        const texte = x.trim();
        return NOMBRE_STRICT.test(texte) ? Number(texte) : null;
      }
      return null;
    },
  },

  string: {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([x]) => {
      if (x === null || x === undefined) return null;
      if (estChaine(x)) return x;
      if (typeof x === 'boolean') return x ? 'true' : 'false';
      if (estNombre(x)) return formaterNombre(x);
      return null;
    },
  },

  /* -- chaînes -- */

  // En points de code Unicode, pas en unités UTF-16 : une contrainte de
  // longueur qui compte « é » pour deux caractères est incompréhensible pour le
  // concepteur d'un formulaire en français (§6.4).
  'string-length': {
    ariteMin: 1,
    ariteMax: 1,
    appliquer: ([s]) => {
      if (s === null || s === undefined) return 0;
      return estChaine(s) ? [...s].length : null;
    },
  },

  substr: {
    ariteMin: 2,
    ariteMax: 3,
    appliquer: ([s, debut, fin]) => {
      if (s === null || s === undefined) return null;
      if (!estChaine(s) || !estNombre(debut ?? null)) return null;
      const points = [...s];
      const d = Math.max(0, Math.trunc(debut as number));
      let f = points.length;
      if (fin !== undefined && fin !== null) {
        if (!estNombre(fin)) return null;
        f = Math.min(points.length, Math.trunc(fin));
      }
      if (f <= d) return '';
      return points.slice(d, f).join('');
    },
  },

  concat: {
    ariteMin: 1,
    ariteMax: null,
    appliquer: (args) => {
      let total = '';
      for (const a of args) {
        if (a === null) continue;
        if (estChaine(a)) total += a;
        else if (estNombre(a)) total += formaterNombre(a);
        else if (typeof a === 'boolean') total += a ? 'true' : 'false';
        else return null;
      }
      return total;
    },
  },

  // Correspondance partielle : ancrer avec ^ et $ pour une correspondance
  // totale. Le motif est un littéral, vérifié à la publication (§6.4).
  regex: {
    ariteMin: 2,
    ariteMax: 2,
    appliquer: ([s, motif]) => {
      if (s === null || s === undefined) return false;
      if (!estChaine(s) || !estChaine(motif ?? null)) return null;
      try {
        return new RegExp(motif as string, 'u').test(s);
      } catch {
        return null;
      }
    },
  },

  /* -- dates -- */

  today: {
    ariteMin: 0,
    ariteMax: 0,
    appliquer: (_args, contexte) => contexte.now.slice(0, 10),
  },

  now: {
    ariteMin: 0,
    ariteMax: 0,
    appliquer: (_args, contexte) => contexte.now,
  },

  'date-diff': {
    ariteMin: 3,
    ariteMax: 3,
    appliquer: ([a, b, unite]) => {
      const debut = analyserDate(a ?? null);
      const fin = analyserDate(b ?? null);
      if (debut === null || fin === null || !estChaine(unite ?? null)) return null;

      const ecartMs = fin.ms - debut.ms;
      switch (unite) {
        case 'minutes':
          return Math.trunc(ecartMs / 60_000);
        case 'heures':
          return Math.trunc(ecartMs / 3_600_000);
        case 'jours':
          return Math.trunc(ecartMs / 86_400_000);
        case 'mois':
          return differenceMois(debut, fin);
        case 'annees':
          return Math.trunc(differenceMois(debut, fin) / 12);
        default:
          return null;
      }
    },
  },
};

function extremum(champ: ValeurExpression, sens: 'min' | 'max'): ValeurExpression {
  const elements = enTableau(champ);
  if (elements === null) return null;
  let resultat: number | null = null;
  for (const e of elements) {
    if (e === null) continue;
    if (!estNombre(e)) return null;
    if (resultat === null) resultat = e;
    else resultat = sens === 'min' ? Math.min(resultat, e) : Math.max(resultat, e);
  }
  return resultat;
}

/**
 * Notation décimale.
 *
 * Au-delà de 1e21, JavaScript ne sait pas produire autre chose qu'une notation
 * exponentielle sans arithmétique arbitraire. Aucun montant ni aucune mesure de
 * terrain n'atteint cet ordre de grandeur, et le cas est couvert par un test
 * qui documente le comportement plutôt que de faire semblant de le traiter.
 */
function formaterNombre(x: number): string {
  return String(x);
}
