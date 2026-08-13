import type { ValeurExpression } from './valeur.js';

/** Opérateurs binaires, voir docs/evaluateur-expressions.md §3.2. */
export type OperateurBinaire =
  | 'ou'
  | 'et'
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | 'mod';

export type Noeud =
  | NoeudLitteral
  | NoeudReference
  | NoeudCourant
  | NoeudUnaire
  | NoeudBinaire
  | NoeudAppel;

export interface NoeudLitteral {
  readonly type: 'litteral';
  readonly valeur: ValeurExpression;
  readonly position: number;
}

/**
 * `${nom}` ou `${groupe.champ}`.
 *
 * Un chemin de plusieurs segments désigne, depuis l'extérieur d'un groupe
 * répétable, le tableau des valeurs de toutes les occurrences (§3.3).
 */
export interface NoeudReference {
  readonly type: 'reference';
  readonly chemin: readonly string[];
  readonly position: number;
}

/** `.` — la valeur de la question courante, dans `constraint` et `default`. */
export interface NoeudCourant {
  readonly type: 'courant';
  readonly position: number;
}

export interface NoeudUnaire {
  readonly type: 'unaire';
  readonly operateur: '-';
  readonly operande: Noeud;
  readonly position: number;
}

export interface NoeudBinaire {
  readonly type: 'binaire';
  readonly operateur: OperateurBinaire;
  readonly gauche: Noeud;
  readonly droite: Noeud;
  readonly position: number;
}

export interface NoeudAppel {
  readonly type: 'appel';
  readonly nom: string;
  readonly arguments: readonly Noeud[];
  readonly position: number;
}

/** Profondeur de l'arbre, pour le contrôle du budget statique (§8). */
export function profondeur(noeud: Noeud): number {
  switch (noeud.type) {
    case 'litteral':
    case 'reference':
    case 'courant':
      return 1;
    case 'unaire':
      return 1 + profondeur(noeud.operande);
    case 'binaire':
      return 1 + Math.max(profondeur(noeud.gauche), profondeur(noeud.droite));
    case 'appel': {
      let max = 0;
      for (const argument of noeud.arguments) {
        max = Math.max(max, profondeur(argument));
      }
      return 1 + max;
    }
  }
}

/** Nombre de nœuds de l'arbre, pour le contrôle du budget statique (§8). */
export function nombreNoeuds(noeud: Noeud): number {
  switch (noeud.type) {
    case 'litteral':
    case 'reference':
    case 'courant':
      return 1;
    case 'unaire':
      return 1 + nombreNoeuds(noeud.operande);
    case 'binaire':
      return 1 + nombreNoeuds(noeud.gauche) + nombreNoeuds(noeud.droite);
    case 'appel': {
      let total = 1;
      for (const argument of noeud.arguments) {
        total += nombreNoeuds(argument);
      }
      return total;
    }
  }
}
