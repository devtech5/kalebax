import { Bouton, Champ, Saisie } from '@kalebax/ui-web';
import { useEffect, useState } from 'react';
import type { ClientApi } from '../api/client.js';

export interface Projet {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
}

export interface ProprietesProjets {
  readonly client: ClientApi;
  readonly onOuvrir: (projet: Projet) => void;
}

const LIBELLE_STATUT: Readonly<Record<string, string>> = {
  draft: 'Brouillon',
  active: 'En cours',
  paused: 'En pause',
  closed: 'Terminé',
};

export function Projets({ client, onOuvrir }: ProprietesProjets) {
  const [projets, setProjets] = useState<Projet[] | null>(null);
  const [erreur, setErreur] = useState<string | undefined>();
  const [nouveau, setNouveau] = useState('');

  async function charger(): Promise<void> {
    try {
      setProjets(await client.projets<Projet[]>());
      setErreur(undefined);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }

  useEffect(() => {
    void charger();
    // Le client est stable pour la durée de la session.
  }, []);

  async function creer(): Promise<void> {
    if (nouveau.trim() === '') return;
    try {
      await client.creerProjet({ name: nouveau.trim() });
      setNouveau('');
      await charger();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Création impossible.');
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold">Projets</h1>

      <div className="flex items-end gap-3">
        <Champ libelle="Nouveau projet" erreur={erreur} className="flex-1">
          <Saisie
            value={nouveau}
            placeholder="Audit points de vente Abidjan T3"
            onChange={(e) => setNouveau(e.target.value)}
            onKeyDown={(e) => {
              // La création au clavier évite un aller-retour à la souris pour
              // ce qui est l'action la plus fréquente de l'écran.
              if (e.key === 'Enter') void creer();
            }}
          />
        </Champ>
        <Bouton onClick={() => void creer()} className="mb-3">
          Créer
        </Bouton>
      </div>

      {projets === null ? (
        <p className="text-[var(--color-texte-attenue)]">Chargement…</p>
      ) : projets.length === 0 ? (
        // Un écran vide sans explication laisse croire à une panne.
        <p className="rounded-[var(--radius-carte)] border border-dashed border-[var(--color-bordure-forte)] px-4 py-8 text-center text-[var(--color-texte-attenue)]">
          Aucun projet pour l’instant. Créez-en un pour commencer à concevoir un
          formulaire.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {projets.map((projet) => (
            <li key={projet.id}>
              <button
                type="button"
                onClick={() => onOuvrir(projet)}
                className="flex w-full min-h-[var(--spacing-tactile-large)] items-center justify-between gap-4 rounded-[var(--radius-carte)] border border-[var(--color-bordure)] bg-[var(--color-surface)] px-4 py-3 text-left hover:border-[var(--color-bordure-forte)]"
              >
                <span>
                  <span className="block font-medium">{projet.name}</span>
                  {projet.description === null ? null : (
                    <span className="block text-sm text-[var(--color-texte-attenue)]">
                      {projet.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded-full bg-[var(--color-fond-attenue)] px-3 py-1 text-sm">
                  {LIBELLE_STATUT[projet.status] ?? projet.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
