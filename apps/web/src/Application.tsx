import { Bouton } from '@kalebax/ui-web';
import { useState } from 'react';
import type { ClientApi } from './api/client.js';
import { Connexion } from './ecrans/Connexion.js';
import { Projets, type Projet } from './ecrans/Projets.js';

export interface ProprietesApplication {
  readonly client: ClientApi;
}

type Vue = { readonly nom: 'projets' } | { readonly nom: 'projet'; readonly projet: Projet };

export function Application({ client }: ProprietesApplication) {
  const [connecte, setConnecte] = useState(client.estConnecte());
  const [vue, setVue] = useState<Vue>({ nom: 'projets' });

  if (!connecte) {
    return <Connexion client={client} onConnecte={() => setConnecte(true)} />;
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--color-bordure)] px-4 py-3">
        <button
          type="button"
          onClick={() => setVue({ nom: 'projets' })}
          className="text-lg font-semibold"
        >
          Kalebax
        </button>
        <Bouton
          variante="discret"
          onClick={() => {
            void client.deconnexion();
            setConnecte(false);
          }}
        >
          Déconnexion
        </Bouton>
      </header>

      {vue.nom === 'projets' ? (
        <Projets client={client} onOuvrir={(projet) => setVue({ nom: 'projet', projet })} />
      ) : (
        <main className="mx-auto w-full max-w-3xl px-4 py-6">
          <h1 className="text-2xl font-semibold">{vue.projet.name}</h1>
          {/* Le concepteur de formulaires et le suivi des soumissions
              arrivent ensuite : mieux vaut un écran qui dit ce qu'il en est
              qu'un bouton qui ne fait rien. */}
          <p className="pt-4 text-[var(--color-texte-attenue)]">
            La conception de formulaires et le suivi des collectes de ce projet
            seront disponibles ici.
          </p>
        </main>
      )}
    </div>
  );
}
