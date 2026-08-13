import { ErreurAnalyse } from './erreurs.js';

export type TypeJeton =
  | 'nombre'
  | 'chaine'
  | 'reference'
  | 'courant'
  | 'identifiant'
  | 'motcle'
  | 'operateur'
  | 'parenthese-ouvrante'
  | 'parenthese-fermante'
  | 'virgule'
  | 'fin';

export interface Jeton {
  readonly type: TypeJeton;
  /** Texte du jeton, ou valeur normalisée pour les chaînes et les références. */
  readonly texte: string;
  readonly position: number;
}

/**
 * `not` n'y figure pas : c'est une fonction, pas un opérateur (§3.2). Ce choix
 * supprime toute ambiguïté de précédence entre la négation et les comparaisons.
 */
const MOTS_CLES = new Set(['and', 'or', 'mod', 'true', 'false', 'null']);

const REFERENCE_VALIDE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;

function estChiffre(c: string): boolean {
  return c >= '0' && c <= '9';
}

function estLettre(c: string): boolean {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function estEspace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * Découpe le texte d'une expression en jetons.
 *
 * Le langage est volontairement pauvre : pas de majuscules dans les
 * identifiants, pas de guillemets doubles, pas d'échappement autre que le
 * guillemet simple doublé. Chaque restriction supprime une divergence possible
 * entre deux implémentations.
 */
export function decouper(texte: string): Jeton[] {
  const jetons: Jeton[] = [];
  let i = 0;

  while (i < texte.length) {
    const c = texte[i] as string;

    if (estEspace(c)) {
      i += 1;
      continue;
    }

    // Référence ${nom} ou ${groupe.champ}
    if (c === '$') {
      const debut = i;
      if (texte[i + 1] !== '{') {
        throw new ErreurAnalyse(
          "Le symbole $ doit introduire une référence de la forme ${nom_question}.",
          debut,
        );
      }
      const fin = texte.indexOf('}', i + 2);
      if (fin === -1) {
        throw new ErreurAnalyse(
          "Référence non refermée : il manque une accolade fermante '}'.",
          debut,
        );
      }
      const contenu = texte.slice(i + 2, fin).trim();
      if (!REFERENCE_VALIDE.test(contenu)) {
        throw new ErreurAnalyse(
          `« ${contenu} » n'est pas un nom de question valide. Un nom s'écrit en minuscules, sans accent, et peut contenir des chiffres et des tirets bas.`,
          debut,
        );
      }
      jetons.push({ type: 'reference', texte: contenu, position: debut });
      i = fin + 1;
      continue;
    }

    // Chaîne 'texte', le guillemet simple s'échappe en le doublant
    if (c === "'") {
      const debut = i;
      let valeur = '';
      i += 1;
      let terminee = false;
      while (i < texte.length) {
        if (texte[i] === "'") {
          if (texte[i + 1] === "'") {
            valeur += "'";
            i += 2;
            continue;
          }
          i += 1;
          terminee = true;
          break;
        }
        valeur += texte[i];
        i += 1;
      }
      if (!terminee) {
        throw new ErreurAnalyse(
          "Chaîne non refermée : il manque un guillemet simple. Pour écrire un guillemet dans une chaîne, doublez-le : 'l''agent'.",
          debut,
        );
      }
      jetons.push({ type: 'chaine', texte: valeur, position: debut });
      continue;
    }

    // Nombre — le signe négatif est un opérateur unaire, pas une partie du littéral
    if (estChiffre(c)) {
      const debut = i;
      while (i < texte.length && estChiffre(texte[i] as string)) i += 1;
      if (texte[i] === '.' && estChiffre(texte[i + 1] ?? '')) {
        i += 1;
        while (i < texte.length && estChiffre(texte[i] as string)) i += 1;
      }
      jetons.push({ type: 'nombre', texte: texte.slice(debut, i), position: debut });
      continue;
    }

    // Identifiant : mot-clé ou nom de fonction. Le tiret n'est absorbé que s'il
    // est suivi d'une lettre — « count-selected » est un nom, « 5-3 » une
    // soustraction, et aucune ambiguïté n'est possible puisque le langage n'a
    // pas de variable nue.
    if (estLettre(c)) {
      const debut = i;
      while (i < texte.length && (estLettre(texte[i] as string) || estChiffre(texte[i] as string))) {
        i += 1;
      }
      while (texte[i] === '-' && estLettre(texte[i + 1] ?? '')) {
        i += 1;
        while (i < texte.length && (estLettre(texte[i] as string) || estChiffre(texte[i] as string))) {
          i += 1;
        }
      }
      const mot = texte.slice(debut, i);
      const type: TypeJeton = MOTS_CLES.has(mot) ? 'motcle' : 'identifiant';
      jetons.push({ type, texte: mot, position: debut });
      continue;
    }

    if (c === '(') {
      jetons.push({ type: 'parenthese-ouvrante', texte: c, position: i });
      i += 1;
      continue;
    }
    if (c === ')') {
      jetons.push({ type: 'parenthese-fermante', texte: c, position: i });
      i += 1;
      continue;
    }
    if (c === ',') {
      jetons.push({ type: 'virgule', texte: c, position: i });
      i += 1;
      continue;
    }
    if (c === '.') {
      jetons.push({ type: 'courant', texte: c, position: i });
      i += 1;
      continue;
    }

    // Opérateurs à deux caractères d'abord
    const deux = texte.slice(i, i + 2);
    if (deux === '<=' || deux === '>=' || deux === '!=') {
      jetons.push({ type: 'operateur', texte: deux, position: i });
      i += 2;
      continue;
    }
    if (deux === '==') {
      throw new ErreurAnalyse(
        "L'égalité s'écrit avec un seul signe égal : =",
        i,
      );
    }
    if (deux === '&&') {
      throw new ErreurAnalyse("L'opérateur « et » s'écrit : and", i);
    }
    if (deux === '||') {
      throw new ErreurAnalyse("L'opérateur « ou » s'écrit : or", i);
    }

    if (c === '=' || c === '<' || c === '>' || c === '+' || c === '-' || c === '*' || c === '/') {
      jetons.push({ type: 'operateur', texte: c, position: i });
      i += 1;
      continue;
    }

    if (c === '!') {
      throw new ErreurAnalyse(
        "La négation s'écrit avec la fonction not(...), et « différent de » s'écrit !=",
        i,
      );
    }

    if (c === '"') {
      throw new ErreurAnalyse(
        'Les chaînes s\'écrivent entre guillemets simples : \'texte\'',
        i,
      );
    }

    throw new ErreurAnalyse(`Caractère inattendu : « ${c} »`, i);
  }

  jetons.push({ type: 'fin', texte: '', position: texte.length });
  return jetons;
}
