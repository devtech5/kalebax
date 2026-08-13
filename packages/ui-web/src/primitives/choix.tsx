import * as Cases from '@radix-ui/react-checkbox';
import * as Radios from '@radix-ui/react-radio-group';
import { useLiaisonsChamp } from './champ.js';
import { cn } from './utils.js';

/**
 * Contrôles de choix.
 *
 * Ils s'appuient sur des primitives accessibles éprouvées plutôt que sur des
 * réécritures maison : un groupe radio fait main gère presque toujours mal les
 * flèches du clavier et le mode formulaire des lecteurs d'écran, et le défaut
 * ne se voit jamais en développement.
 */

export interface Choix {
  readonly valeur: string;
  readonly libelle: string;
}

/**
 * Seuil au-delà duquel une liste déroulante remplace les boutons radio.
 *
 * En dessous, les options visibles d'un coup valent toujours mieux : une seule
 * touche au lieu d'ouvrir un menu, et rien à mémoriser. Au-dessus, la page
 * devient un mur et le défilement coûte plus qu'il ne rapporte.
 */
export const SEUIL_LISTE_DEROULANTE = 7;

const styleOption = [
  'flex items-center gap-3 min-h-[var(--spacing-tactile)] px-4 py-2',
  'rounded-[var(--radius-champ)] border border-[var(--color-bordure)]',
  'bg-[var(--color-surface)] cursor-pointer',
  'transition-colors duration-[var(--duree-transition)]',
  'hover:border-[var(--color-bordure-forte)]',
  'has-[:checked]:border-[var(--color-accent)] has-[:checked]:bg-[var(--color-accent-attenue)]',
];

const styleMarque = [
  'flex size-6 shrink-0 items-center justify-center',
  'border-2 border-[var(--color-bordure-forte)]',
  'data-[state=checked]:border-[var(--color-accent)] data-[state=checked]:bg-[var(--color-accent)]',
];

export interface ProprietesGroupeRadio {
  readonly options: readonly Choix[];
  readonly valeur: string | undefined;
  readonly onChange: (valeur: string) => void;
  readonly desactive?: boolean | undefined;
}

export function GroupeRadio({
  options,
  valeur,
  onChange,
  desactive = false,
}: ProprietesGroupeRadio) {
  const { idControle, idAide, idErreur, enErreur } = useLiaisonsChamp();
  const decrit = [idAide, idErreur].filter(Boolean).join(' ');

  return (
    <Radios.Root
      id={idControle}
      value={valeur ?? ''}
      onValueChange={onChange}
      disabled={desactive}
      aria-invalid={enErreur ? true : undefined}
      aria-describedby={decrit === '' ? undefined : decrit}
      className="flex flex-col gap-2"
    >
      {options.map((option) => (
        <label key={option.valeur} className={cn(styleOption)}>
          <Radios.Item
            value={option.valeur}
            className={cn(styleMarque, 'rounded-full')}
          >
            <Radios.Indicator className="size-2.5 rounded-full bg-[var(--color-accent-contraste)]" />
          </Radios.Item>
          <span className="text-base">{option.libelle}</span>
        </label>
      ))}
    </Radios.Root>
  );
}

export interface ProprietesGroupeCases {
  readonly options: readonly Choix[];
  readonly valeurs: readonly string[];
  readonly onChange: (valeurs: string[]) => void;
  readonly desactive?: boolean | undefined;
}

export function GroupeCases({
  options,
  valeurs,
  onChange,
  desactive = false,
}: ProprietesGroupeCases) {
  const { idControle, idAide, idErreur, enErreur } = useLiaisonsChamp();
  const decrit = [idAide, idErreur].filter(Boolean).join(' ');
  const selection = new Set(valeurs);

  const basculer = (option: string, coche: boolean): void => {
    const suivante = new Set(selection);
    if (coche) suivante.add(option);
    else suivante.delete(option);
    // L'ordre des options fait foi : sans cela, l'ordre de sélection de
    // l'agent se retrouverait dans les données exportées.
    onChange(options.filter((o) => suivante.has(o.valeur)).map((o) => o.valeur));
  };

  return (
    <div
      role="group"
      id={idControle}
      aria-invalid={enErreur ? true : undefined}
      aria-describedby={decrit === '' ? undefined : decrit}
      className="flex flex-col gap-2"
    >
      {options.map((option) => (
        <label key={option.valeur} className={cn(styleOption)}>
          <Cases.Root
            checked={selection.has(option.valeur)}
            onCheckedChange={(coche) => basculer(option.valeur, coche === true)}
            disabled={desactive}
            className={cn(styleMarque, 'rounded-[0.25rem]')}
          >
            <Cases.Indicator className="text-[var(--color-accent-contraste)]">
              <span aria-hidden="true" className="text-sm font-bold">
                ✓
              </span>
            </Cases.Indicator>
          </Cases.Root>
          <span className="text-base">{option.libelle}</span>
        </label>
      ))}
    </div>
  );
}

export interface ProprietesListe {
  readonly options: readonly Choix[];
  readonly valeur: string | undefined;
  readonly onChange: (valeur: string) => void;
  readonly desactive?: boolean | undefined;
  readonly placeholder?: string | undefined;
}

/**
 * Liste déroulante native.
 *
 * Le contrôle du système est retenu volontairement : sur un téléphone, il
 * ouvre le sélecteur natif, qui gère le défilement à un doigt, la saisie au
 * clavier et l'accessibilité mieux qu'aucune réécriture — et sans un octet de
 * JavaScript supplémentaire.
 */
export function Liste({
  options,
  valeur,
  onChange,
  desactive = false,
  placeholder = 'Sélectionner…',
}: ProprietesListe) {
  const { idControle, idAide, idErreur, enErreur } = useLiaisonsChamp();
  const decrit = [idAide, idErreur].filter(Boolean).join(' ');

  return (
    <select
      id={idControle}
      value={valeur ?? ''}
      onChange={(evenement) => onChange(evenement.target.value)}
      disabled={desactive}
      aria-invalid={enErreur ? true : undefined}
      aria-describedby={decrit === '' ? undefined : decrit}
      className={cn(
        'w-full min-h-[var(--spacing-tactile)] px-4',
        'rounded-[var(--radius-champ)] bg-[var(--color-surface)] text-base',
        enErreur
          ? 'border-2 border-[var(--color-danger)]'
          : 'border border-[var(--color-bordure)]',
      )}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.valeur} value={option.valeur}>
          {option.libelle}
        </option>
      ))}
    </select>
  );
}
