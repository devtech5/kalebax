import type { Noeud, OperateurBinaire } from './ast.js';
import { ErreurAnalyse } from './erreurs.js';
import { decouper, type Jeton, type TypeJeton } from './lexer.js';
import { LIMITES_EXPRESSION } from './limites.js';

/**
 * Analyse syntaxique par descente récursive, un niveau de fonction par rang de
 * précédence (§3.2). Tous les opérateurs binaires sont associatifs à gauche.
 *
 * La profondeur est contrôlée **pendant** l'analyse et non après : une
 * expression de profondeur 10 000 ferait déborder la pile d'appels avant qu'on
 * ait pu mesurer l'arbre produit.
 */
class Analyseur {
  private index = 0;
  private profondeurCourante = 0;

  constructor(private readonly jetons: readonly Jeton[]) {}

  private get courant(): Jeton {
    // Le lexer garantit un jeton 'fin' terminal, l'index ne peut pas sortir.
    return this.jetons[this.index] as Jeton;
  }

  private avancer(): Jeton {
    const jeton = this.courant;
    if (jeton.type !== 'fin') this.index += 1;
    return jeton;
  }

  /**
   * Appel de méthode plutôt qu'accès direct à `this.courant` : TypeScript
   * conserve le narrowing d'un getter à travers un appel qui le fait pourtant
   * avancer, et le code se retrouverait à raisonner sur un jeton déjà consommé.
   */
  private estType(type: TypeJeton): boolean {
    return this.courant.type === type;
  }

  private entrer(): void {
    this.profondeurCourante += 1;
    if (this.profondeurCourante > LIMITES_EXPRESSION.profondeurArbre) {
      throw new ErreurAnalyse(
        `Expression trop imbriquée : la profondeur maximale est de ${LIMITES_EXPRESSION.profondeurArbre} niveaux.`,
        this.courant.position,
        'budget-statique',
      );
    }
  }

  private sortir(): void {
    this.profondeurCourante -= 1;
  }

  analyser(): Noeud {
    const noeud = this.ou();
    if (this.courant.type !== 'fin') {
      throw new ErreurAnalyse(
        `Texte inattendu après la fin de l'expression : « ${this.courant.texte} »`,
        this.courant.position,
      );
    }
    return noeud;
  }

  /** Construit une chaîne d'opérateurs de même rang, associative à gauche. */
  private binaire(
    suivant: () => Noeud,
    correspond: (jeton: Jeton) => OperateurBinaire | null,
  ): Noeud {
    this.entrer();
    let gauche = suivant();
    for (;;) {
      const operateur = correspond(this.courant);
      if (operateur === null) break;
      const position = this.avancer().position;
      const droite = suivant();
      gauche = { type: 'binaire', operateur, gauche, droite, position };
    }
    this.sortir();
    return gauche;
  }

  private ou(): Noeud {
    return this.binaire(
      () => this.et(),
      (j) => (j.type === 'motcle' && j.texte === 'or' ? 'ou' : null),
    );
  }

  private et(): Noeud {
    return this.binaire(
      () => this.egalite(),
      (j) => (j.type === 'motcle' && j.texte === 'and' ? 'et' : null),
    );
  }

  private egalite(): Noeud {
    return this.binaire(
      () => this.comparaison(),
      (j) =>
        j.type === 'operateur' && (j.texte === '=' || j.texte === '!=')
          ? (j.texte as OperateurBinaire)
          : null,
    );
  }

  private comparaison(): Noeud {
    return this.binaire(
      () => this.additif(),
      (j) =>
        j.type === 'operateur' &&
        (j.texte === '<' || j.texte === '<=' || j.texte === '>' || j.texte === '>=')
          ? (j.texte as OperateurBinaire)
          : null,
    );
  }

  private additif(): Noeud {
    return this.binaire(
      () => this.multiplicatif(),
      (j) =>
        j.type === 'operateur' && (j.texte === '+' || j.texte === '-')
          ? (j.texte as OperateurBinaire)
          : null,
    );
  }

  private multiplicatif(): Noeud {
    return this.binaire(
      () => this.unaire(),
      (j) => {
        if (j.type === 'operateur' && (j.texte === '*' || j.texte === '/')) {
          return j.texte;
        }
        if (j.type === 'motcle' && j.texte === 'mod') return 'mod';
        return null;
      },
    );
  }

  private unaire(): Noeud {
    if (this.courant.type === 'operateur' && this.courant.texte === '-') {
      this.entrer();
      const position = this.avancer().position;
      const operande = this.unaire();
      this.sortir();
      return { type: 'unaire', operateur: '-', operande, position };
    }
    return this.primaire();
  }

  private primaire(): Noeud {
    const jeton = this.courant;

    switch (jeton.type) {
      case 'nombre':
        this.avancer();
        return { type: 'litteral', valeur: Number(jeton.texte), position: jeton.position };

      case 'chaine':
        this.avancer();
        return { type: 'litteral', valeur: jeton.texte, position: jeton.position };

      case 'reference':
        this.avancer();
        return {
          type: 'reference',
          chemin: jeton.texte.split('.'),
          position: jeton.position,
        };

      case 'courant':
        this.avancer();
        return { type: 'courant', position: jeton.position };

      case 'motcle':
        if (jeton.texte === 'true' || jeton.texte === 'false' || jeton.texte === 'null') {
          this.avancer();
          const valeur = jeton.texte === 'null' ? null : jeton.texte === 'true';
          return { type: 'litteral', valeur, position: jeton.position };
        }
        throw new ErreurAnalyse(
          `L'opérateur « ${jeton.texte} » attend une valeur à sa gauche.`,
          jeton.position,
        );

      case 'identifiant': {
        this.avancer();
        if (!this.estType('parenthese-ouvrante')) {
          throw new ErreurAnalyse(
            `« ${jeton.texte} » n'est pas une valeur. Pour lire une réponse, écrivez \${${jeton.texte}} ; pour appeler une fonction, ajoutez des parenthèses.`,
            jeton.position,
          );
        }
        this.entrer();
        this.avancer();
        const args: Noeud[] = [];
        if (!this.estType('parenthese-fermante')) {
          for (;;) {
            args.push(this.ou());
            if (this.estType('virgule')) {
              this.avancer();
              continue;
            }
            break;
          }
        }
        if (!this.estType('parenthese-fermante')) {
          throw new ErreurAnalyse(
            `Parenthèse fermante manquante dans l'appel à ${jeton.texte}().`,
            this.courant.position,
          );
        }
        this.avancer();
        this.sortir();
        return {
          type: 'appel',
          nom: jeton.texte,
          arguments: args,
          position: jeton.position,
        };
      }

      case 'parenthese-ouvrante': {
        this.entrer();
        this.avancer();
        const interne = this.ou();
        if (!this.estType('parenthese-fermante')) {
          throw new ErreurAnalyse(
            'Parenthèse fermante manquante.',
            this.courant.position,
          );
        }
        this.avancer();
        this.sortir();
        return interne;
      }

      case 'fin':
        throw new ErreurAnalyse('Expression incomplète.', jeton.position);

      default:
        throw new ErreurAnalyse(
          `Valeur attendue, mais « ${jeton.texte} » trouvé.`,
          jeton.position,
        );
    }
  }
}

/** Découpe puis analyse. Lève `ErreurAnalyse` ; voir `analyser()` pour la façade. */
export function construireArbre(texte: string): Noeud {
  if (texte.length > LIMITES_EXPRESSION.longueurTexte) {
    throw new ErreurAnalyse(
      `Expression trop longue : ${texte.length} caractères pour un maximum de ${LIMITES_EXPRESSION.longueurTexte}.`,
      LIMITES_EXPRESSION.longueurTexte,
      'budget-statique',
    );
  }
  if (texte.trim() === '') {
    throw new ErreurAnalyse('Expression vide.', 0);
  }
  return new Analyseur(decouper(texte)).analyser();
}
