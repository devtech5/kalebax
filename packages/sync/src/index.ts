export { MoteurSync, TAILLE_MORCEAU } from './moteur.js';
export type {
  OptionsMoteur,
  OptionsSynchronisation,
  RapportSync,
} from './moteur.js';

export { decouperEnLots, estimerOctets, OCTETS_LOT_MAX, TAILLE_LOT_MAX } from './lots.js';
export type { Lot } from './lots.js';

export { delaiTentative, prochaineTentative, PALIERS_SECONDES, VARIATION } from './temporisation.js';

export { ErreurChecksum, ErreurTransport, versSortante } from './transport.js';
export type {
  EtatElement,
  LecteurFichiers,
  ResultatElement,
  SoumissionSortante,
  TransportSync,
} from './transport.js';
