import type { RuntimeSaisie } from '@kalebax/form-runtime';
import { estQuestion, type DocumentFormulaire } from '@kalebax/shared';
import { useCallback, useMemo, useState } from 'react';
import { Bouton } from './primitives/bouton.js';
import { RenduQuestion, traduire } from './questions/question.js';

export interface ProprietesFormulaire {
  readonly runtime: RuntimeSaisie;
  readonly document: DocumentFormulaire;
  readonly langue?: string | undefined;
  readonly onFinaliser?: (() => void) | undefined;
}

/**
 * Affiche une saisie en cours, page par page.
 *
 * Le composant ne décide de rien : il lit l'état du runtime et lui transmet les
 * réponses. Toute la logique — pertinence, calculs, contraintes, navigation —
 * vit dans `packages/form-runtime`, une seule fois pour les trois cibles.
 */
export function Formulaire({
  runtime,
  document,
  langue,
  onFinaliser,
}: ProprietesFormulaire) {
  // Le runtime est muté en place : ce compteur force le rendu après chaque
  // changement, sans recopier tout l'état à chaque frappe.
  const [revision, setRevision] = useState(0);
  const rafraichir = useCallback(() => setRevision((r) => r + 1), []);

  const langueAffichee = langue ?? document.defaultLanguage;
  const pages = useMemo(() => runtime.pages(), [runtime, revision]);
  const violations = useMemo(() => runtime.violations(), [runtime, revision]);

  const page = pages[runtime.pageCourante()];
  const visibles = pages.filter((p) => p.visible);
  const rang = page === undefined ? 0 : visibles.findIndex((p) => p.index === page.index);
  const derniere = rang === visibles.length - 1;

  const erreurDe = (name: string): string | undefined =>
    violations.find((v) => v.name === name && v.emplacement === undefined)?.message;

  if (page === undefined) return null;

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-28 pt-4"
      // La soumission implicite au clavier enverrait la saisie depuis
      // n'importe quel champ ; la navigation passe par les boutons.
      onSubmit={(evenement) => evenement.preventDefault()}
    >
      <header className="pb-2">
        <h1 className="text-xl font-semibold">
          {traduire(document.title, langueAffichee, document.defaultLanguage)}
        </h1>
        {/* La progression rassure : un agent qui ne sait pas combien il reste
            abandonne plus facilement une visite longue. */}
        <p
          className="text-sm text-[var(--color-texte-attenue)]"
          aria-live="polite"
        >
          Page {rang + 1} sur {visibles.length}
        </p>
      </header>

      {page.groupe === undefined ? null : (
        <h2 className="pt-2 text-lg font-medium">
          {traduire(page.groupe.label, langueAffichee, document.defaultLanguage)}
        </h2>
      )}

      {page.elements
        .filter((affichable) => affichable.pertinent)
        .map((affichable) => {
          const element = affichable.element;
          if (!estQuestion(element)) return null;
          return (
            <RenduQuestion
              key={element.id}
              question={element}
              valeur={runtime.lire(element.name)}
              erreur={erreurDe(element.name)}
              langue={langueAffichee}
              langueParDefaut={document.defaultLanguage}
              onChange={(valeur) => {
                runtime.repondre(element.name, valeur);
                rafraichir();
              }}
            />
          );
        })}

      <nav
        className="fixed inset-x-0 bottom-0 border-t border-[var(--color-bordure)] bg-[var(--color-surface)] px-4 py-3"
        aria-label="Navigation dans le formulaire"
      >
        <div className="mx-auto flex max-w-2xl gap-3">
          <Bouton
            variante="secondaire"
            disabled={rang === 0}
            onClick={() => {
              runtime.allerPrecedent();
              rafraichir();
            }}
          >
            Précédent
          </Bouton>

          {derniere ? (
            <Bouton
              className="flex-1"
              onClick={() => onFinaliser?.()}
            >
              Terminer
            </Bouton>
          ) : (
            <Bouton
              className="flex-1"
              onClick={() => {
                runtime.allerSuivant();
                rafraichir();
              }}
            >
              Suivant
            </Bouton>
          )}
        </div>

        {/* Le nombre de manques est indiqué, mais rien n'est bloqué : un agent
            arrêté par une contrainte mal écrite à 300 km du bureau est un
            échec produit. Le serveur enregistrera la soumission avec ses
            violations, pour arbitrage. */}
        {violations.length === 0 ? null : (
          <p className="mx-auto max-w-2xl pt-2 text-sm text-[var(--color-texte-attenue)]">
            {violations.length} réponse{violations.length > 1 ? 's' : ''} à
            vérifier avant l’envoi.
          </p>
        )}
      </nav>
    </form>
  );
}
