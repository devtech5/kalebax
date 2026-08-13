import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './utils.js';

/**
 * Bouton.
 *
 * Hauteur minimale de 48 px sur toutes les variantes : la saisie se fait
 * debout, au doigt, parfois avec des gants. Une variante « petite » à 32 px
 * finirait par être utilisée sur l'écran d'un agent.
 */
const styles = cva(
  [
    'inline-flex items-center justify-center gap-2',
    'rounded-[var(--radius-champ)] font-medium',
    'transition-colors duration-[var(--duree-transition)]',
    // Le survol ne peut pas être le seul retour : il n'existe pas au doigt.
    'active:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variante: {
        principal:
          'bg-[var(--color-accent)] text-[var(--color-accent-contraste)] hover:brightness-110',
        secondaire:
          'border border-[var(--color-bordure-forte)] bg-[var(--color-surface)] text-[var(--color-texte)] hover:bg-[var(--color-fond-attenue)]',
        discret:
          'text-[var(--color-texte)] hover:bg-[var(--color-fond-attenue)]',
        danger:
          'bg-[var(--color-danger)] text-[var(--color-accent-contraste)] hover:brightness-110',
      },
      taille: {
        normal: 'min-h-[var(--spacing-tactile)] px-5 text-base',
        large: 'min-h-[var(--spacing-tactile-large)] px-7 text-lg w-full',
      },
    },
    defaultVariants: { variante: 'principal', taille: 'normal' },
  },
);

export interface ProprietesBouton
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof styles> {}

export const Bouton = forwardRef<HTMLButtonElement, ProprietesBouton>(
  function Bouton({ className, variante, taille, type = 'button', ...reste }, ref) {
    return (
      <button
        ref={ref}
        // Sans type explicite, un bouton dans un formulaire le soumet : c'est
        // la première cause de saisie perdue par un clic mal placé.
        type={type}
        className={cn(styles({ variante, taille }), className)}
        {...reste}
      />
    );
  },
);
