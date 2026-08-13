import { Bouton, Champ, Saisie } from '@kalebax/ui-web';
import { useState, type FormEvent } from 'react';
import type { Appartenance, ClientApi } from '../api/client.js';

export interface ProprietesConnexion {
  readonly client: ClientApi;
  readonly onConnecte: () => void;
}

export function Connexion({ client, onConnecte }: ProprietesConnexion) {
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | undefined>();
  const [enCours, setEnCours] = useState(false);
  const [choix, setChoix] = useState<readonly Appartenance[] | null>(null);

  async function soumettre(
    evenement: FormEvent,
    organizationId?: string,
  ): Promise<void> {
    evenement.preventDefault();
    setErreur(undefined);
    setEnCours(true);

    try {
      const resultat = await client.connexion(email, motDePasse, organizationId);
      if (resultat.type === 'choix') {
        // Un enquêteur travaille couramment pour deux agences : aucun jeton
        // n'est émis tant qu'il n'a pas dit pour laquelle il se connecte.
        setChoix(resultat.appartenances);
        return;
      }
      onConnecte();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Connexion impossible.');
    } finally {
      setEnCours(false);
    }
  }

  if (choix !== null) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-4">
        <h1 className="text-xl font-semibold">Choisissez votre organisation</h1>
        {choix.map((appartenance) => (
          <Bouton
            key={appartenance.organizationId}
            variante="secondaire"
            taille="large"
            onClick={(evenement) => void soumettre(evenement, appartenance.organizationId)}
          >
            {appartenance.organizationName}
          </Bouton>
        ))}
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4">
      <form onSubmit={(evenement) => void soumettre(evenement)} className="flex flex-col gap-2">
        <h1 className="pb-2 text-2xl font-semibold">Kalebax</h1>

        <Champ libelle="Adresse email" erreur={erreur}>
          <Saisie
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Champ>

        <Champ libelle="Mot de passe">
          <Saisie
            type="password"
            autoComplete="current-password"
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.target.value)}
          />
        </Champ>

        <Bouton type="submit" taille="large" disabled={enCours} className="mt-2">
          {enCours ? 'Connexion…' : 'Se connecter'}
        </Bouton>
      </form>
    </main>
  );
}
