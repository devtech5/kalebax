import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './Application.js';
import { ClientApi } from './api/client.js';
import './styles.css';

const racine = document.getElementById('racine');
if (racine === null) throw new Error('Élément racine introuvable.');

// Chemin relatif : le mandataire de développement le résout vers l'API, et
// l'application desktop l'embarque sans supposer de domaine.
const client = new ClientApi({ baseUrl: '/api' });

createRoot(racine).render(
  <StrictMode>
    <Application client={client} />
  </StrictMode>,
);
