import type { Noeud } from '../expression/ast.js';
import type { TypeSaisie } from './types.js';

/**
 * Vérification statique des types d'une expression — docs/evaluateur-expressions.md
 * §9 point 5.
 *
 * Principe directeur : **ne jamais bloquer à tort.** Un faux positif empêche un
 * concepteur de publier un formulaire correct, ce qui est pire qu'un faux
 * négatif — l'évaluation, elle, rendra simplement `null`. Toute incertitude
 * produit donc le type `inconnu`, qui ne déclenche aucune erreur.
 */
export type TypeInfere = 'nombre' | 'texte' | 'booleen' | 'tableau' | 'inconnu';

export interface AnomalieType {
  readonly message: string;
  readonly position: number;
}

/**
 * Type produit par chaque type de question.
 *
 * Les types géographiques valent `inconnu` : ce sont des objets structurés, pas
 * une des cinq valeurs du langage (§2). L'évaluateur les rend `null`, et il n'y
 * a rien à vérifier statiquement à leur sujet.
 */
const TYPE_PAR_SAISIE: Readonly<Record<TypeSaisie, TypeInfere>> = {
  text: 'texte',
  integer: 'nombre',
  decimal: 'nombre',
  date: 'texte',
  time: 'texte',
  datetime: 'texte',
  select_one: 'texte',
  select_multiple: 'tableau',
  rank: 'tableau',
  geopoint: 'inconnu',
  geotrace: 'inconnu',
  geoshape: 'inconnu',
  photo: 'tableau',
  audio: 'tableau',
  video: 'tableau',
  file: 'tableau',
  signature: 'texte',
  barcode: 'texte',
  // Le type d'un champ calculé dépend de son expression : le supposer serait
  // la première source de refus injustifié.
  calculate: 'inconnu',
  note: 'inconnu',
};

export function typeDeSaisie(type: TypeSaisie): TypeInfere {
  return TYPE_PAR_SAISIE[type];
}

/** Type de retour de chaque fonction, et exigences sur ses arguments. */
interface SignatureFonction {
  readonly retour: TypeInfere;
  /** Type attendu par position ; `inconnu` signifie « n'importe lequel ». */
  readonly arguments: readonly TypeInfere[];
  /** Type attendu pour les arguments au-delà de la liste, si arité variable. */
  readonly reste?: TypeInfere;
}

export const SIGNATURES: Readonly<Record<string, SignatureFonction>> = {
  not: { retour: 'booleen', arguments: ['booleen'] },
  if: { retour: 'inconnu', arguments: ['booleen', 'inconnu', 'inconnu'] },
  coalesce: { retour: 'inconnu', arguments: [], reste: 'inconnu' },

  selected: { retour: 'booleen', arguments: ['inconnu', 'texte'] },
  'count-selected': { retour: 'nombre', arguments: ['inconnu'] },
  count: { retour: 'nombre', arguments: ['inconnu'] },
  position: { retour: 'nombre', arguments: [] },

  sum: { retour: 'nombre', arguments: ['inconnu'] },
  min: { retour: 'nombre', arguments: ['inconnu'] },
  max: { retour: 'nombre', arguments: ['inconnu'] },
  round: { retour: 'nombre', arguments: ['nombre', 'nombre'] },
  int: { retour: 'nombre', arguments: ['nombre'] },
  number: { retour: 'nombre', arguments: ['inconnu'] },
  string: { retour: 'texte', arguments: ['inconnu'] },

  'string-length': { retour: 'nombre', arguments: ['texte'] },
  substr: { retour: 'texte', arguments: ['texte', 'nombre', 'nombre'] },
  concat: { retour: 'texte', arguments: [], reste: 'inconnu' },
  regex: { retour: 'booleen', arguments: ['texte', 'texte'] },

  today: { retour: 'texte', arguments: [] },
  now: { retour: 'texte', arguments: [] },
  'date-diff': { retour: 'nombre', arguments: ['texte', 'texte', 'texte'] },
};

const NOM_LISIBLE: Readonly<Record<TypeInfere, string>> = {
  nombre: 'un nombre',
  texte: 'du texte',
  booleen: 'une condition vraie ou fausse',
  tableau: 'une liste de valeurs',
  inconnu: 'une valeur',
};

export interface ContexteTypage {
  /** Type de chaque question du formulaire, par nom. */
  readonly typesParNom: ReadonlyMap<string, TypeInfere>;
  /** Type de la question qui porte l'expression, pour `.`. */
  readonly typeCourant?: TypeInfere | undefined;
}

/**
 * Infère le type d'une expression et relève les incompatibilités certaines.
 *
 * Une incompatibilité n'est signalée que si les deux types en présence sont
 * connus et inconciliables. Dès qu'un `inconnu` intervient, on se tait.
 */
export function verifierTypes(
  noeud: Noeud,
  contexte: ContexteTypage,
): { readonly type: TypeInfere; readonly anomalies: readonly AnomalieType[] } {
  const anomalies: AnomalieType[] = [];

  const incompatible = (attendu: TypeInfere, obtenu: TypeInfere): boolean =>
    attendu !== 'inconnu' && obtenu !== 'inconnu' && attendu !== obtenu;

  const inferer = (n: Noeud): TypeInfere => {
    switch (n.type) {
      case 'litteral': {
        const v = n.valeur;
        if (typeof v === 'number') return 'nombre';
        if (typeof v === 'string') return 'texte';
        if (typeof v === 'boolean') return 'booleen';
        // `null` est compatible avec tout : c'est la valeur d'une question sans
        // réponse, qui peut apparaître partout.
        return 'inconnu';
      }

      case 'reference': {
        // Un chemin composé agrège les occurrences d'un groupe répétable.
        if (n.chemin.length > 1) return 'tableau';
        const premier = n.chemin[0];
        if (premier === undefined) return 'inconnu';
        return contexte.typesParNom.get(premier) ?? 'inconnu';
      }

      case 'courant':
        return contexte.typeCourant ?? 'inconnu';

      case 'unaire': {
        const operande = inferer(n.operande);
        if (incompatible('nombre', operande)) {
          anomalies.push({
            message: `Le signe moins attend un nombre, mais reçoit ${NOM_LISIBLE[operande]}.`,
            position: n.position,
          });
        }
        return 'nombre';
      }

      case 'binaire': {
        const gauche = inferer(n.gauche);
        const droite = inferer(n.droite);

        switch (n.operateur) {
          case 'et':
          case 'ou': {
            for (const cote of [gauche, droite]) {
              if (incompatible('booleen', cote)) {
                anomalies.push({
                  message: `« ${n.operateur === 'et' ? 'and' : 'or'} » attend des conditions de part et d'autre, mais reçoit ${NOM_LISIBLE[cote]}.`,
                  position: n.position,
                });
              }
            }
            return 'booleen';
          }

          case '=':
          case '!=':
            // L'égalité accepte tout, y compris null de part et d'autre : c'est
            // la seule façon d'écrire « cette question n'a pas de réponse ».
            return 'booleen';

          case '<':
          case '<=':
          case '>':
          case '>=': {
            if (incompatible(gauche, droite)) {
              anomalies.push({
                message: `Comparaison impossible entre ${NOM_LISIBLE[gauche]} et ${NOM_LISIBLE[droite]}.`,
                position: n.position,
              });
            } else if (gauche === 'booleen' || gauche === 'tableau') {
              anomalies.push({
                message: `On ne peut pas classer ${NOM_LISIBLE[gauche]} par ordre croissant ou décroissant.`,
                position: n.position,
              });
            }
            return 'booleen';
          }

          default: {
            for (const cote of [gauche, droite]) {
              if (incompatible('nombre', cote)) {
                anomalies.push({
                  message:
                    cote === 'texte'
                      ? `« ${n.operateur} » attend des nombres. Pour convertir du texte en nombre, utilisez number(...) ; pour assembler du texte, utilisez concat(...).`
                      : `« ${n.operateur} » attend des nombres, mais reçoit ${NOM_LISIBLE[cote]}.`,
                  position: n.position,
                });
              }
            }
            return 'nombre';
          }
        }
      }

      case 'appel': {
        const signature = SIGNATURES[n.nom];
        const typesArguments = n.arguments.map(inferer);
        // Fonction inconnue : déjà signalée par la validation d'arité.
        if (signature === undefined) return 'inconnu';

        typesArguments.forEach((obtenu, index) => {
          const attendu = signature.arguments[index] ?? signature.reste ?? 'inconnu';
          if (incompatible(attendu, obtenu)) {
            anomalies.push({
              message: `${n.nom}() attend ${NOM_LISIBLE[attendu]} en argument ${index + 1}, mais reçoit ${NOM_LISIBLE[obtenu]}.`,
              position: n.arguments[index]?.position ?? n.position,
            });
          }
        });

        // if() rend le type de ses branches quand elles s'accordent.
        if (n.nom === 'if') {
          const siVrai = typesArguments[1] ?? 'inconnu';
          const siFaux = typesArguments[2] ?? 'inconnu';
          return siVrai === siFaux ? siVrai : 'inconnu';
        }
        if (n.nom === 'coalesce') {
          const premier = typesArguments[0] ?? 'inconnu';
          return typesArguments.every((t) => t === premier) ? premier : 'inconnu';
        }

        return signature.retour;
      }
    }
  };

  const type = inferer(noeud);
  return { type, anomalies };
}
