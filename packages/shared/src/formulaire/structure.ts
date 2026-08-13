import { z } from 'zod';
import { MOTIF_NOM, TYPES_SAISIE } from './types.js';

/**
 * Validation **structurelle** du document de formulaire.
 *
 * Elle ne vérifie que la forme : types, présence, format. Tout ce qui demande
 * de regarder le document dans son ensemble — unicité des noms, expressions
 * analysables, cycles, profondeur des répétitions — vit dans `regles.ts`.
 *
 * Les objets sont **stricts** : une clé inconnue est refusée. C'est ce qui
 * attrape « requiered » au lieu de « required » dans un document écrit à la
 * main ou converti depuis XLSForm. L'évolutivité du format ne passe pas par la
 * tolérance aux clés inconnues mais par `schemaVersion`, qui permet de refuser
 * proprement un document trop récent au lieu de l'interpréter de travers.
 */

const libelle = z
  .record(z.string(), z.string())
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Un libellé doit être fourni dans au moins une langue.',
  });

const nom = z
  .string()
  .regex(
    MOTIF_NOM,
    "Un nom de variable s'écrit en minuscules sans accent, commence par une lettre ou un tiret bas, et ne contient que des lettres, des chiffres et des tirets bas.",
  );

const codeLangue = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Code de langue invalide (exemples : fr, en, fr-CI).');

const option = z.strictObject({
  value: z.string().min(1, "La valeur d'une option ne peut pas être vide."),
  label: libelle,
  allowFreeText: z.boolean().optional(),
  freeTextLabel: libelle.optional(),
});

const sourceOptions = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inline') }),
  z.strictObject({ kind: z.literal('dataset'), dataset: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('cascade'),
    dataset: z.string().min(1),
    filter: z.string().min(1),
  }),
]);

const communs = {
  id: z.string().min(1, "L'identifiant technique ne peut pas être vide."),
  name: nom,
  label: libelle,
  hint: libelle.optional(),
  relevant: z.string().min(1).optional(),
  appearance: z.string().min(1).optional(),
  locked: z.boolean().optional(),
};

const question = z.strictObject({
  ...communs,
  type: z.enum(TYPES_SAISIE),
  required: z.union([z.boolean(), z.string().min(1)]).optional(),
  constraint: z.string().min(1).optional(),
  constraintMessage: libelle.optional(),
  default: z.string().min(1).optional(),
  readOnly: z.boolean().optional(),
  personalData: z.boolean().optional(),
  optionsSource: sourceOptions.optional(),
  options: z.array(option).optional(),
  minCount: z.int().min(0).optional(),
  maxCount: z.int().min(1).optional(),
  calculation: z.string().min(1).optional(),
});

const element: z.ZodType<unknown> = z.lazy(() =>
  z.union([question, groupe, repetition]),
);

const groupe = z.strictObject({
  ...communs,
  type: z.literal('group'),
  children: z.array(element),
});

const repetition = z.strictObject({
  ...communs,
  type: z.literal('repeat'),
  children: z.array(element),
  repeatCount: z.string().min(1).optional(),
  minRepeat: z.int().min(0).optional(),
  // Obligatoire : sans plafond, un formulaire peut saturer la mémoire d'un
  // téléphone d'entrée de gamme en pleine collecte (§5.4).
  maxRepeat: z.int().min(1, 'Un groupe répétable doit déclarer un plafond maxRepeat.'),
});

const parametres = z.strictObject({
  requireStartGeopoint: z.boolean().optional(),
  minGeopointAccuracy: z.number().positive().optional(),
  allowDraftSave: z.boolean().optional(),
  singleSubmissionPerAssignment: z.boolean().optional(),
});

export const SCHEMA_DOCUMENT = z.strictObject({
  schemaVersion: z.int().min(1),
  title: libelle,
  defaultLanguage: codeLangue,
  languages: z.array(codeLangue).min(1, 'Au moins une langue doit être déclarée.'),
  settings: parametres.optional(),
  children: z.array(element),
});
