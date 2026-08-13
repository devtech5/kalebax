import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Fusionne des classes en laissant la dernière gagner.
 *
 * Sans elle, une classe passée en propriété par l'appelant se retrouve derrière
 * celle du composant dans la feuille de style, et la surcharge échoue de façon
 * imprévisible selon l'ordre de compilation.
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
