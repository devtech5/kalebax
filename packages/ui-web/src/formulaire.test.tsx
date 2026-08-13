// @vitest-environment jsdom
import { RuntimeSaisie } from '@kalebax/form-runtime';
import { validerDocument, type DocumentFormulaire } from '@kalebax/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Formulaire } from './formulaire.js';
import { RenduQuestion } from './questions/question.js';

const NOW = '2026-08-13T09:00:00.000Z';

// Le nettoyage automatique de Testing Library n'est enregistré qu'avec les
// globales de Vitest. Ici, il est explicite.
afterEach(cleanup);

// jsdom n'implémente pas ResizeObserver, dont les primitives accessibles se
// servent pour se dimensionner. Rien à mesurer dans un test : un observateur
// inerte suffit.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

function doc(children: unknown[]): DocumentFormulaire {
  const resultat = validerDocument({
    schemaVersion: 1,
    title: { fr: 'Relevé de linéaire' },
    defaultLanguage: 'fr',
    languages: ['fr'],
    children,
  });
  if (!resultat.ok) throw new Error(resultat.anomalies.map((a) => a.message).join(' / '));
  return resultat.document;
}

function q(name: string, type = 'text', extra: Record<string, unknown> = {}) {
  return { id: `q_${name}`, name, type, label: { fr: name }, ...extra };
}

function monter(children: unknown[]) {
  const document = doc(children);
  const runtime = RuntimeSaisie.creer(document, { now: NOW });
  const rendu = render(<Formulaire runtime={runtime} document={document} />);
  return { runtime, document, rendu };
}

describe('libellés et accessibilité', () => {
  it('associe le libellé à son champ', () => {
    // Un libellé posé à côté d'un champ sans association n'est pas un libellé
    // pour un lecteur d'écran, et le défaut ne se voit jamais à l'œil.
    monter([q('nom', 'text', { label: { fr: 'Nom de la boutique' } })]);
    expect(screen.getByLabelText(/Nom de la boutique/)).toBeDefined();
  });

  it('annonce une question obligatoire autrement que par un astérisque', () => {
    monter([q('nom', 'text', { label: { fr: 'Nom' }, required: true })]);
    expect(screen.getByLabelText(/Nom.*obligatoire/s)).toBeDefined();
  });

  it('rattache l\'aide au champ', () => {
    monter([
      q('prix', 'integer', {
        label: { fr: 'Prix' },
        hint: { fr: 'Prix affiché en rayon, hors promotion' },
      }),
    ]);
    const champ = screen.getByLabelText(/Prix/);
    const decrit = champ.getAttribute('aria-describedby');
    expect(decrit).toBeTruthy();
    expect(document.getElementById(decrit as string)?.textContent).toContain(
      'hors promotion',
    );
  });

  it('ouvre le pavé numérique pour un entier', () => {
    // Sur cent relevés de prix, le gain est réel.
    monter([q('prix', 'integer', { label: { fr: 'Prix' } })]);
    expect(screen.getByLabelText(/Prix/).getAttribute('inputmode')).toBe('numeric');
  });
});

describe('saisie', () => {
  it('transmet la réponse au runtime', async () => {
    const utilisateur = userEvent.setup();
    const { runtime } = monter([q('nom', 'text', { label: { fr: 'Nom' } })]);

    await utilisateur.type(screen.getByLabelText(/Nom/), 'Boutique Awa');
    expect(runtime.lire('nom')).toBe('Boutique Awa');
  });

  it('vide la réponse quand le champ numérique est effacé', async () => {
    const utilisateur = userEvent.setup();
    const { runtime } = monter([q('prix', 'integer', { label: { fr: 'Prix' } })]);

    const champ = screen.getByLabelText(/Prix/);
    await utilisateur.type(champ, '500');
    expect(runtime.lire('prix')).toBe(500);

    await utilisateur.clear(champ);
    expect(runtime.lire('prix')).toBeUndefined();
  });

  it('coche une option unique', async () => {
    const utilisateur = userEvent.setup();
    const { runtime } = monter([
      q('region', 'select_one', {
        label: { fr: 'Région' },
        optionsSource: { kind: 'inline' },
        options: [
          { value: 'abidjan', label: { fr: 'Abidjan' } },
          { value: 'bouake', label: { fr: 'Bouaké' } },
        ],
      }),
    ]);

    await utilisateur.click(screen.getByRole('radio', { name: 'Bouaké' }));
    expect(runtime.lire('region')).toBe('bouake');
  });

  it('conserve l\'ordre des options dans une sélection multiple', async () => {
    // Sans cela, l'ordre de sélection de l'agent se retrouverait dans les
    // données exportées.
    const utilisateur = userEvent.setup();
    const { runtime } = monter([
      q('langues', 'select_multiple', {
        label: { fr: 'Langues' },
        optionsSource: { kind: 'inline' },
        options: [
          { value: 'fr', label: { fr: 'Français' } },
          { value: 'dioula', label: { fr: 'Dioula' } },
          { value: 'baoule', label: { fr: 'Baoulé' } },
        ],
      }),
    ]);

    await utilisateur.click(screen.getByRole('checkbox', { name: 'Baoulé' }));
    await utilisateur.click(screen.getByRole('checkbox', { name: 'Français' }));

    expect(runtime.lire('langues')).toEqual(['fr', 'baoule']);
  });
});

describe('choix du contrôle selon le nombre d\'options', () => {
  function optionsInline(nombre: number) {
    return {
      optionsSource: { kind: 'inline' },
      options: Array.from({ length: nombre }, (_, i) => ({
        value: `v${i}`,
        label: { fr: `Option ${i}` },
      })),
    };
  }

  it('montre des boutons radio pour une liste courte', () => {
    // Une seule touche au lieu d'ouvrir un menu, et rien à mémoriser.
    monter([q('court', 'select_one', { label: { fr: 'Court' }, ...optionsInline(4) })]);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('bascule en liste déroulante au-delà du seuil', () => {
    monter([q('long', 'select_one', { label: { fr: 'Long' }, ...optionsInline(12) })]);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('combobox')).toBeDefined();
  });
});

describe('pertinence', () => {
  it('ne rend pas une question masquée', () => {
    // Le rendu ne décide de rien : il suit l'état du runtime.
    monter([
      q('present', 'text', { label: { fr: 'Produit présent' } }),
      q('prix', 'integer', {
        label: { fr: 'Prix' },
        relevant: "${present} = 'oui'",
      }),
    ]);
    expect(screen.queryByLabelText(/Prix/)).toBeNull();
  });
});

describe('violations', () => {
  it('annonce l\'erreur et la rattache au champ', async () => {
    const utilisateur = userEvent.setup();
    monter([
      q('prix', 'integer', {
        label: { fr: 'Prix' },
        constraint: '. > 0',
        constraintMessage: { fr: 'Le prix doit être positif' },
      }),
    ]);

    await utilisateur.type(screen.getByLabelText(/Prix/), '-5');

    const alerte = await screen.findByRole('alert');
    expect(alerte.textContent).toContain('Le prix doit être positif');

    const champ = screen.getByLabelText(/Prix/);
    expect(champ.getAttribute('aria-invalid')).toBe('true');
    expect(champ.getAttribute('aria-describedby')).toContain(alerte.id);
  });

  it('n\'empêche pas d\'avancer malgré une violation', async () => {
    // Un agent arrêté par une contrainte mal écrite à 300 km du bureau est un
    // échec produit.
    const utilisateur = userEvent.setup();
    monter([
      q('prix', 'integer', { label: { fr: 'Prix' }, constraint: '. > 0' }),
      q('suite', 'text', { label: { fr: 'Suite' } }),
    ]);

    await utilisateur.type(screen.getByLabelText(/Prix/), '-5');
    const suivant = screen.getByRole('button', { name: /Suivant/ });
    expect(suivant.hasAttribute('disabled')).toBe(false);

    await utilisateur.click(suivant);
    expect(screen.getByLabelText(/Suite/)).toBeDefined();
  });
});

describe('navigation', () => {
  const pages = [
    q('a', 'text', { label: { fr: 'Première' } }),
    q('b', 'text', { label: { fr: 'Deuxième' } }),
  ];

  it('indique la progression', () => {
    monter(pages);
    expect(screen.getByText(/Page 1 sur 2/)).toBeDefined();
  });

  it('avance et recule', async () => {
    const utilisateur = userEvent.setup();
    monter(pages);

    await utilisateur.click(screen.getByRole('button', { name: /Suivant/ }));
    expect(screen.getByLabelText(/Deuxième/)).toBeDefined();

    await utilisateur.click(screen.getByRole('button', { name: /Précédent/ }));
    expect(screen.getByLabelText(/Première/)).toBeDefined();
  });

  it('désactive le retour sur la première page', () => {
    monter(pages);
    expect(
      screen.getByRole('button', { name: /Précédent/ }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('propose de terminer sur la dernière page', async () => {
    const utilisateur = userEvent.setup();
    monter(pages);
    await utilisateur.click(screen.getByRole('button', { name: /Suivant/ }));
    expect(screen.getByRole('button', { name: /Terminer/ })).toBeDefined();
  });
});

describe('saisie au clavier seul', () => {
  it('atteint chaque champ dans l\'ordre visuel', async () => {
    // Sur le poste de saisie régional, une opératrice traite deux cents
    // questionnaires par jour sans toucher la souris.
    const utilisateur = userEvent.setup();
    monter([
      {
        id: 'g_page',
        name: 'page',
        type: 'group',
        label: { fr: 'Relevé' },
        appearance: 'field-list',
        children: [
          q('premier', 'text', { label: { fr: 'Premier' } }),
          q('deuxieme', 'text', { label: { fr: 'Deuxième' } }),
          q('troisieme', 'text', { label: { fr: 'Troisième' } }),
        ],
      },
    ]);

    await utilisateur.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/Premier/));
    await utilisateur.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/Deuxième/));
    await utilisateur.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/Troisième/));
  });

  it('saisit sans souris et remonte la valeur', async () => {
    const utilisateur = userEvent.setup();
    const { runtime } = monter([q('nom', 'text', { label: { fr: 'Nom' } })]);

    await utilisateur.tab();
    await utilisateur.keyboard('Boutique du marché');
    expect(runtime.lire('nom')).toBe('Boutique du marché');
  });
});

describe('types dépendant du matériel', () => {
  it('annonce une photo au lieu d\'un bouton inerte', () => {
    // Un bouton qui ne fait rien use plus la confiance qu'un message honnête.
    monter([q('photos', 'photo', { label: { fr: 'Photos' }, maxCount: 5 })]);
    expect(screen.getByText(/application de collecte/)).toBeDefined();
  });

  it('n\'affiche pas un champ calculé', () => {
    // Le montrer laisserait croire qu'on peut le corriger.
    monter([
      q('prix', 'integer', { label: { fr: 'Prix' } }),
      q('total', 'calculate', { label: { fr: 'Total' }, calculation: '${prix} * 2' }),
    ]);
    expect(screen.queryByLabelText(/Total/)).toBeNull();
  });

  it('affiche une note sans en faire un champ', () => {
    monter([q('info', 'note', { label: { fr: 'Munissez-vous du relevé papier' } })]);
    expect(screen.getByText(/relevé papier/)).toBeDefined();
    expect(screen.queryByLabelText(/relevé papier/)).toBeNull();
  });
});

describe('langues', () => {
  it('replie sur la langue par défaut plutôt que d\'afficher un vide', () => {
    render(
      <RenduQuestion
        question={{
          id: 'q1',
          name: 'nom',
          type: 'text',
          label: { fr: 'Nom' },
        }}
        valeur={undefined}
        langue="en"
        langueParDefaut="fr"
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('Nom')).toBeDefined();
  });

  it('affiche la traduction quand elle existe', () => {
    render(
      <RenduQuestion
        question={{
          id: 'q1',
          name: 'nom',
          type: 'text',
          label: { fr: 'Nom', en: 'Name' },
        }}
        valeur={undefined}
        langue="en"
        langueParDefaut="fr"
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('Name')).toBeDefined();
  });
});

describe('cibles tactiles', () => {
  it('donne aux boutons la hauteur minimale attendue', () => {
    // 48 px et non 44 : la saisie se fait debout, au doigt, parfois avec des
    // gants.
    monter([q('a', 'text', { label: { fr: 'A' } })]);
    const nav = screen.getByRole('navigation');
    for (const bouton of within(nav).getAllByRole('button')) {
      expect(bouton.className).toContain('min-h-[var(--spacing-tactile)]');
    }
  });
});
