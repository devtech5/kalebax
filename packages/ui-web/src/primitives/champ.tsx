import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './utils.js';

/**
 * Enveloppe d'une question : libellé, aide, contrôle, message d'erreur.
 *
 * Elle existe pour que le lien entre les quatre soit établi une seule fois. Un
 * libellé posé à côté d'un champ sans `htmlFor` n'est pas un libellé pour un
 * lecteur d'écran, et c'est l'erreur d'accessibilité la plus fréquente — parce
 * qu'elle ne se voit jamais à l'œil.
 */
interface ContexteChamp {
  readonly idControle: string;
  readonly idAide?: string | undefined;
  readonly idErreur?: string | undefined;
  readonly enErreur: boolean;
}

const Contexte = createContext<ContexteChamp | null>(null);

function useChamp(): ContexteChamp {
  const contexte = useContext(Contexte);
  if (contexte === null) {
    throw new Error('Ce contrôle doit être placé dans un <Champ>.');
  }
  return contexte;
}

export interface ProprietesChamp {
  readonly libelle: string;
  readonly aide?: string | undefined;
  readonly erreur?: string | undefined;
  readonly obligatoire?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export function Champ({
  libelle,
  aide,
  erreur,
  obligatoire = false,
  children,
  className,
}: ProprietesChamp) {
  const base = useId();
  const idControle = `${base}-controle`;
  const idAide = aide === undefined ? undefined : `${base}-aide`;
  const idErreur = erreur === undefined ? undefined : `${base}-erreur`;

  return (
    <Contexte.Provider
      value={{ idControle, idAide, idErreur, enErreur: erreur !== undefined }}
    >
      <div className={cn('flex flex-col gap-2 py-3', className)}>
        <label
          htmlFor={idControle}
          className="text-base font-medium text-[var(--color-texte)]"
        >
          {libelle}
          {obligatoire ? (
            <>
              {' '}
              <span aria-hidden="true" className="text-[var(--color-danger)]">
                *
              </span>
              {/* L'astérisque seule n'est lue par aucun lecteur d'écran, et ne
                  se distingue pas sur un écran délavé. */}
              <span className="sr-only">(obligatoire)</span>
            </>
          ) : null}
        </label>

        {aide === undefined ? null : (
          <p id={idAide} className="text-sm text-[var(--color-texte-attenue)]">
            {aide}
          </p>
        )}

        {children}

        {erreur === undefined ? null : (
          <p
            id={idErreur}
            // Annoncé sans voler le focus : l'agent est peut-être en train de
            // corriger un autre champ.
            role="alert"
            className="flex items-start gap-2 text-sm font-medium text-[var(--color-danger)]"
          >
            {/* L'erreur se lit par trois signaux — icône, texte, bordure — et
                jamais par la couleur seule. */}
            <span aria-hidden="true">⚠</span>
            <span>{erreur}</span>
          </p>
        )}
      </div>
    </Contexte.Provider>
  );
}

const stylesControle = [
  'w-full min-h-[var(--spacing-tactile)] px-4 py-2',
  'rounded-[var(--radius-champ)] border bg-[var(--color-surface)]',
  'text-[var(--color-texte)] placeholder:text-[var(--color-texte-attenue)]',
  'transition-colors duration-[var(--duree-transition)]',
  'disabled:cursor-not-allowed disabled:bg-[var(--color-fond-attenue)] disabled:opacity-70',
];

function bordure(enErreur: boolean): string {
  return enErreur
    ? 'border-2 border-[var(--color-danger)] bg-[var(--color-danger-attenue)]'
    : 'border-[var(--color-bordure)] hover:border-[var(--color-bordure-forte)]';
}

/** Attributs d'accessibilité communs, à ne jamais réécrire à la main. */
function liaisons(contexte: ContexteChamp): Record<string, string | boolean | undefined> {
  const decrit = [contexte.idAide, contexte.idErreur].filter(Boolean).join(' ');
  return {
    id: contexte.idControle,
    'aria-invalid': contexte.enErreur ? true : undefined,
    'aria-describedby': decrit === '' ? undefined : decrit,
  };
}

export const Saisie = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>
>(function Saisie({ className, ...reste }, ref) {
  const contexte = useChamp();
  return (
    <input
      ref={ref}
      {...liaisons(contexte)}
      className={cn(stylesControle, bordure(contexte.enErreur), className)}
      {...reste}
    />
  );
});

export const ZoneTexte = forwardRef<
  HTMLTextAreaElement,
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>
>(function ZoneTexte({ className, rows = 4, ...reste }, ref) {
  const contexte = useChamp();
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...liaisons(contexte)}
      className={cn(stylesControle, bordure(contexte.enErreur), 'resize-y', className)}
      {...reste}
    />
  );
});

/** Pour les contrôles composés — groupe radio, cases — qui portent eux-mêmes leurs liaisons. */
export function useLiaisonsChamp(): ContexteChamp {
  return useChamp();
}
