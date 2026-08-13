import type { Noeud } from './ast.js';

/**
 * Noms de questions lus par une expression, dans l'ordre d'apparition et sans
 * doublon. Pour un chemin composé `${produits.prix}`, seul le premier segment
 * est retenu : la dépendance porte sur le groupe répétable.
 */
export function extraireReferences(noeud: Noeud): string[] {
  const noms = new Set<string>();
  const parcourir = (n: Noeud): void => {
    switch (n.type) {
      case 'reference': {
        const premier = n.chemin[0];
        if (premier !== undefined) noms.add(premier);
        return;
      }
      case 'unaire':
        parcourir(n.operande);
        return;
      case 'binaire':
        parcourir(n.gauche);
        parcourir(n.droite);
        return;
      case 'appel':
        for (const argument of n.arguments) parcourir(argument);
        return;
      case 'litteral':
      case 'courant':
        return;
    }
  };
  parcourir(noeud);
  return [...noms];
}

export interface ReferenceSituee {
  readonly nom: string;
  /** Vrai pour `${groupe.champ}` : un agrégat sur un groupe répétable. */
  readonly compose: boolean;
  readonly position: number;
}

/** Références avec leur position, pour situer une anomalie dans le texte. */
export function extraireReferencesSituees(noeud: Noeud): ReferenceSituee[] {
  const trouvees: ReferenceSituee[] = [];
  const parcourir = (n: Noeud): void => {
    switch (n.type) {
      case 'reference': {
        const premier = n.chemin[0];
        if (premier !== undefined) {
          trouvees.push({
            nom: premier,
            compose: n.chemin.length > 1,
            position: n.position,
          });
        }
        return;
      }
      case 'unaire':
        parcourir(n.operande);
        return;
      case 'binaire':
        parcourir(n.gauche);
        parcourir(n.droite);
        return;
      case 'appel':
        for (const argument of n.arguments) parcourir(argument);
        return;
      case 'litteral':
      case 'courant':
        return;
    }
  };
  parcourir(noeud);
  return trouvees;
}

/** Une question et ce qu'elle lit. */
export interface Dependance {
  readonly nom: string;
  readonly lit: readonly string[];
}

export interface ResultatGraphe {
  /**
   * Ordre d'évaluation : une question n'apparaît jamais avant celles qu'elle
   * lit. Vide si un cycle a été détecté.
   */
  readonly ordre: readonly string[];
  /** Chemin du premier cycle trouvé, par exemple `prix → remise → total → prix`. */
  readonly cycle: readonly string[] | null;
}

/**
 * Tri topologique des dépendances entre questions.
 *
 * Sert à trois choses (§10) : ordonner les recalculs pour ne réévaluer que ce
 * qui dépend d'une réponse modifiée, refuser un cycle à la publication, et
 * fixer l'ordre d'évaluation initial des `calculate` et des `default`.
 *
 * Le résultat est sérialisé avec le document de formulaire : une version
 * publiée étant immuable, le recalculer au démarrage de l'application serait du
 * temps d'attente offert à l'agent pour un résultat qui ne peut pas changer.
 */
export function construireGraphe(
  dependances: readonly Dependance[],
): ResultatGraphe {
  const lecteurs = new Map<string, string[]>();
  const restant = new Map<string, number>();
  const connus = new Set(dependances.map((d) => d.nom));

  for (const { nom } of dependances) {
    restant.set(nom, 0);
  }

  for (const { nom, lit } of dependances) {
    for (const lu of new Set(lit)) {
      // Une référence hors du formulaire est signalée par la validation ; ici
      // elle n'entre simplement pas dans le graphe.
      if (!connus.has(lu) || lu === nom) continue;
      const liste = lecteurs.get(lu);
      if (liste === undefined) lecteurs.set(lu, [nom]);
      else liste.push(nom);
      restant.set(nom, (restant.get(nom) ?? 0) + 1);
    }
  }

  // Une question qui se lit elle-même est un cycle de longueur 1, que la
  // boucle ci-dessus a délibérément ignoré : on le rattrape ici.
  for (const { nom, lit } of dependances) {
    if (lit.includes(nom)) return { ordre: [], cycle: [nom, nom] };
  }

  const file: string[] = [];
  for (const [nom, compte] of restant) {
    if (compte === 0) file.push(nom);
  }

  const ordre: string[] = [];
  while (file.length > 0) {
    const nom = file.shift() as string;
    ordre.push(nom);
    for (const lecteur of lecteurs.get(nom) ?? []) {
      const compte = (restant.get(lecteur) ?? 0) - 1;
      restant.set(lecteur, compte);
      if (compte === 0) file.push(lecteur);
    }
  }

  if (ordre.length === dependances.length) {
    return { ordre, cycle: null };
  }

  const impliques = new Set(dependances.map((d) => d.nom));
  for (const nom of ordre) impliques.delete(nom);
  return { ordre: [], cycle: trouverCycle(dependances, impliques) };
}

/** Reconstitue un chemin de cycle lisible pour le message d'erreur. */
function trouverCycle(
  dependances: readonly Dependance[],
  impliques: ReadonlySet<string>,
): readonly string[] {
  const lectures = new Map<string, readonly string[]>();
  for (const { nom, lit } of dependances) {
    lectures.set(nom, lit);
  }

  const enCours = new Set<string>();
  const chemin: string[] = [];

  const descendre = (nom: string): readonly string[] | null => {
    if (enCours.has(nom)) {
      const debut = chemin.indexOf(nom);
      return [...chemin.slice(debut), nom];
    }
    if (!impliques.has(nom)) return null;

    enCours.add(nom);
    chemin.push(nom);
    for (const lu of lectures.get(nom) ?? []) {
      const trouve = descendre(lu);
      if (trouve !== null) return trouve;
    }
    chemin.pop();
    enCours.delete(nom);
    return null;
  };

  for (const nom of impliques) {
    const trouve = descendre(nom);
    if (trouve !== null) return trouve;
  }
  return [...impliques];
}
