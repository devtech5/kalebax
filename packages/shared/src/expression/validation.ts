import { nombreNoeuds, type Noeud } from './ast.js';
import { erreur, type ErreurExpression } from './erreurs.js';
import { FONCTIONS } from './fonctions.js';
import { LIMITES_EXPRESSION } from './limites.js';

/**
 * Détecte les motifs d'expression régulière à explosion combinatoire.
 *
 * Un quantificateur appliqué à un groupe qui contient lui-même un
 * quantificateur — `(a+)+` — fait exploser le temps d'exécution du moteur sur
 * une entrée qui ne correspond pas. Sur le serveur, cela suffirait à saturer un
 * cœur ; sur le téléphone d'un agent, cela fige l'application en pleine
 * collecte. Ces motifs sont refusés à la publication.
 */
export function motifRisque(motif: string): boolean {
  if (/\\[1-9]/.test(motif)) return true;

  const pilesDebut: number[] = [];
  for (let i = 0; i < motif.length; i += 1) {
    const c = motif[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '(') {
      pilesDebut.push(i);
      continue;
    }
    if (c === ')') {
      const debut = pilesDebut.pop();
      if (debut === undefined) continue;
      const suivant = motif[i + 1];
      const quantifie = suivant === '*' || suivant === '+' || suivant === '{';
      if (!quantifie) continue;
      const contenu = motif.slice(debut + 1, i).replace(/\\./g, '');
      // Deux formes explosent : une répétition dans un groupe lui-même répété
      // — (a+)+ — et une alternance ambiguë répétée — (a|a)*, où le moteur
      // essaie toutes les découpes avant d'abandonner.
      if (/[*+{]/.test(contenu) || contenu.includes('|')) return true;
    }
  }
  return false;
}

export interface OptionsValidation {
  /**
   * Noms de questions existant dans le formulaire. Omis, les références ne sont
   * pas vérifiées — utile tant que le schéma n'est pas disponible.
   */
  readonly nomsConnus?: ReadonlySet<string> | undefined;
}

/**
 * Contrôles de publication portant sur un arbre déjà construit (§9).
 *
 * Restent hors de portée tant que le schéma de formulaire n'est pas codé : la
 * vérification statique des types et le refus d'une référence à une question
 * définie plus loin. Les deux exigent la liste ordonnée des questions et leur
 * type déclaré.
 */
export function validerArbre(
  noeud: Noeud,
  options: OptionsValidation = {},
): ErreurExpression[] {
  const erreurs: ErreurExpression[] = [];

  const total = nombreNoeuds(noeud);
  if (total > LIMITES_EXPRESSION.nombreNoeuds) {
    erreurs.push(
      erreur(
        'budget-statique',
        `Expression trop complexe : ${total} éléments pour un maximum de ${LIMITES_EXPRESSION.nombreNoeuds}.`,
        noeud.position,
      ),
    );
  }

  const parcourir = (n: Noeud): void => {
    switch (n.type) {
      case 'reference': {
        const premier = n.chemin[0];
        if (
          options.nomsConnus !== undefined &&
          premier !== undefined &&
          !options.nomsConnus.has(premier)
        ) {
          erreurs.push(
            erreur(
              'reference-inconnue',
              `La question « ${premier} » n'existe pas dans ce formulaire.`,
              n.position,
            ),
          );
        }
        return;
      }

      case 'appel': {
        const definition = FONCTIONS[n.nom];
        if (definition === undefined) {
          erreurs.push(
            erreur('fonction-inconnue', `La fonction ${n.nom}() n'existe pas.`, n.position),
          );
        } else {
          const arite = n.arguments.length;
          const { ariteMin, ariteMax } = definition;
          if (arite < ariteMin || (ariteMax !== null && arite > ariteMax)) {
            const attendu =
              ariteMax === null
                ? `au moins ${ariteMin}`
                : ariteMin === ariteMax
                  ? `${ariteMin}`
                  : `entre ${ariteMin} et ${ariteMax}`;
            erreurs.push(
              erreur(
                'arite-incorrecte',
                `La fonction ${n.nom}() attend ${attendu} argument(s), mais en reçoit ${arite}.`,
                n.position,
              ),
            );
          }
        }

        if (n.nom === 'regex') {
          validerRegex(n, erreurs);
        }

        for (const argument of n.arguments) parcourir(argument);
        return;
      }

      case 'unaire':
        parcourir(n.operande);
        return;
      case 'binaire':
        parcourir(n.gauche);
        parcourir(n.droite);
        return;
      case 'litteral':
      case 'courant':
        return;
    }
  };

  parcourir(noeud);
  return erreurs;
}

function validerRegex(
  n: Extract<Noeud, { type: 'appel' }>,
  erreurs: ErreurExpression[],
): void {
  const motif = n.arguments[1];
  if (motif === undefined) return;

  if (motif.type !== 'litteral' || typeof motif.valeur !== 'string') {
    erreurs.push(
      erreur(
        'argument-non-litteral',
        "Le motif de regex() doit être écrit directement entre guillemets, pas calculé : un motif construit à l'exécution ne peut pas être vérifié à la publication.",
        motif.position,
      ),
    );
    return;
  }

  if (motif.valeur.length > LIMITES_EXPRESSION.longueurMotifRegex) {
    erreurs.push(
      erreur(
        'budget-statique',
        `Motif trop long : ${motif.valeur.length} caractères pour un maximum de ${LIMITES_EXPRESSION.longueurMotifRegex}.`,
        motif.position,
      ),
    );
  }

  if (motifRisque(motif.valeur)) {
    erreurs.push(
      erreur(
        'regex-risquee',
        'Ce motif peut bloquer l\'application sur certaines saisies : il applique une répétition à un groupe qui en contient déjà une, ou utilise une référence arrière.',
        motif.position,
      ),
    );
  }

  try {
    new RegExp(motif.valeur, 'u');
  } catch {
    erreurs.push(
      erreur('syntaxe', "Ce motif n'est pas une expression régulière valide.", motif.position),
    );
  }
}
