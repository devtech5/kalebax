import type { Libelle, Option, Question } from '@kalebax/shared';
import { Champ, Saisie, ZoneTexte } from '../primitives/champ.js';
import {
  GroupeCases,
  GroupeRadio,
  Liste,
  SEUIL_LISTE_DEROULANTE,
  type Choix,
} from '../primitives/choix.js';

export interface ProprietesQuestion {
  readonly question: Question;
  readonly valeur: unknown;
  readonly erreur?: string | undefined;
  readonly langue: string;
  readonly langueParDefaut: string;
  readonly onChange: (valeur: unknown) => void;
  /** Options venues d'un jeu de données, chargées par l'application. */
  readonly optionsExternes?: readonly Choix[] | undefined;
}

/** Replie sur la langue par défaut plutôt que d'afficher un libellé vide. */
export function traduire(
  libelle: Libelle | undefined,
  langue: string,
  parDefaut: string,
): string {
  if (libelle === undefined) return '';
  return libelle[langue] ?? libelle[parDefaut] ?? Object.values(libelle)[0] ?? '';
}

function versChoix(options: readonly Option[], langue: string, parDefaut: string): Choix[] {
  return options.map((option) => ({
    valeur: option.value,
    libelle: traduire(option.label, langue, parDefaut),
  }));
}

/**
 * Rendu d'une question, par type.
 *
 * Aucune décision métier ici : la pertinence, les calculs et les violations
 * viennent du runtime. Un rendu qui déciderait lui-même de masquer une question
 * créerait une deuxième vérité, et les deux divergeraient.
 */
export function RenduQuestion({
  question,
  valeur,
  erreur,
  langue,
  langueParDefaut,
  onChange,
  optionsExternes,
}: ProprietesQuestion) {
  const libelle = traduire(question.label, langue, langueParDefaut);
  const aide = traduire(question.hint, langue, langueParDefaut) || undefined;
  const obligatoire = question.required === true;
  const lectureSeule = question.readOnly === true;

  // Un texte d'information ne collecte rien : l'envelopper dans un champ lui
  // donnerait un libellé et une place dans la tabulation sans aucun contrôle
  // derrière.
  if (question.type === 'note') {
    return (
      <p className="py-3 text-base text-[var(--color-texte-attenue)]">{libelle}</p>
    );
  }

  // Un champ calculé n'est jamais affiché : il est dérivé, et le montrer
  // laisserait croire qu'on peut le corriger.
  if (question.type === 'calculate') return null;

  const commun = { libelle, aide, erreur, obligatoire };
  const texte = typeof valeur === 'string' ? valeur : '';

  switch (question.type) {
    case 'text':
      return (
        <Champ {...commun}>
          {question.appearance === 'multiline' ? (
            <ZoneTexte
              value={texte}
              readOnly={lectureSeule}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Saisie
              value={texte}
              readOnly={lectureSeule}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </Champ>
      );

    case 'integer':
    case 'decimal':
      return (
        <Champ {...commun}>
          <Saisie
            type="number"
            // Le pavé numérique s'ouvre directement sur téléphone : sur cent
            // relevés de prix, le gain est réel.
            inputMode={question.type === 'integer' ? 'numeric' : 'decimal'}
            step={question.type === 'integer' ? 1 : 'any'}
            value={typeof valeur === 'number' ? String(valeur) : ''}
            readOnly={lectureSeule}
            onChange={(e) => {
              const brut = e.target.value;
              if (brut === '') return onChange(null);
              const nombre = Number(brut);
              onChange(Number.isFinite(nombre) ? nombre : null);
            }}
          />
        </Champ>
      );

    case 'date':
    case 'time':
    case 'datetime':
      return (
        <Champ {...commun}>
          <Saisie
            type={question.type === 'datetime' ? 'datetime-local' : question.type}
            value={texte}
            readOnly={lectureSeule}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          />
        </Champ>
      );

    case 'barcode':
      return (
        <Champ {...commun} aide={aide ?? 'Saisir ou scanner le code'}>
          <Saisie
            value={texte}
            readOnly={lectureSeule}
            // La saisie manuelle reste possible : un lecteur qui refuse un
            // code-barres abîmé ne doit pas bloquer la visite.
            onChange={(e) => onChange(e.target.value)}
          />
        </Champ>
      );

    case 'select_one': {
      const options =
        optionsExternes ??
        versChoix(question.options ?? [], langue, langueParDefaut);
      return (
        <Champ {...commun}>
          {options.length > SEUIL_LISTE_DEROULANTE ? (
            <Liste
              options={options}
              valeur={typeof valeur === 'string' ? valeur : undefined}
              onChange={onChange}
              desactive={lectureSeule}
            />
          ) : (
            <GroupeRadio
              options={options}
              valeur={typeof valeur === 'string' ? valeur : undefined}
              onChange={onChange}
              desactive={lectureSeule}
            />
          )}
        </Champ>
      );
    }

    case 'select_multiple':
    case 'rank': {
      const options =
        optionsExternes ??
        versChoix(question.options ?? [], langue, langueParDefaut);
      return (
        <Champ {...commun}>
          <GroupeCases
            options={options}
            valeurs={Array.isArray(valeur) ? (valeur as string[]) : []}
            onChange={onChange}
            desactive={lectureSeule}
          />
        </Champ>
      );
    }

    // Les types qui exigent le matériel de l'appareil sont annoncés plutôt que
    // rendus à moitié : un bouton qui ne fait rien use plus la confiance qu'un
    // message honnête.
    case 'geopoint':
    case 'geotrace':
    case 'geoshape':
    case 'photo':
    case 'audio':
    case 'video':
    case 'file':
    case 'signature':
      return (
        <Champ {...commun}>
          <p className="rounded-[var(--radius-champ)] border border-dashed border-[var(--color-bordure-forte)] px-4 py-4 text-sm text-[var(--color-texte-attenue)]">
            {DESCRIPTION_MATERIEL[question.type]}
          </p>
        </Champ>
      );

    default:
      return null;
  }
}

const DESCRIPTION_MATERIEL: Readonly<Record<string, string>> = {
  geopoint: 'Position à capturer depuis l’application de collecte.',
  geotrace: 'Parcours à enregistrer depuis l’application de collecte.',
  geoshape: 'Zone à tracer depuis l’application de collecte.',
  photo: 'Photo à prendre depuis l’application de collecte.',
  audio: 'Enregistrement à réaliser depuis l’application de collecte.',
  video: 'Vidéo à filmer depuis l’application de collecte.',
  file: 'Fichier à joindre depuis l’application de collecte.',
  signature: 'Signature à recueillir depuis l’application de collecte.',
};
