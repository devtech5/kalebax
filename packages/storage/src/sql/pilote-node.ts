import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { PiloteSql } from './pilote.js';

/**
 * Pilote SQLite pour Node — tests, poste de saisie desktop, développement.
 *
 * `node:sqlite` fait partie de la plateforme depuis Node 22 : aucune
 * dépendance, aucune compilation native, et le même moteur que sur mobile. Il
 * permet de rejouer la suite de conformité sur du vrai SQL à chaque
 * modification, plutôt que sur une imitation en mémoire.
 */
export class PiloteSqlNode implements PiloteSql {
  private readonly base: DatabaseSync;
  private profondeurBloc = 0;

  constructor(chemin = ':memory:') {
    this.base = new DatabaseSync(chemin);
    // Sans cela, SQLite n'applique pas les clés étrangères — silencieusement.
    this.base.exec('PRAGMA foreign_keys = ON');
  }

  async executer(sql: string, parametres: readonly unknown[] = []): Promise<void> {
    if (parametres.length === 0) {
      this.base.exec(sql);
      return;
    }
    this.base.prepare(sql).run(...normaliser(parametres));
  }

  async interroger<T>(sql: string, parametres: readonly unknown[] = []): Promise<T[]> {
    return this.base.prepare(sql).all(...normaliser(parametres)) as T[];
  }

  /**
   * Les blocs s'imbriquent : `purgerConfirmeesAvant` appelle `enBloc` alors
   * qu'un appelant peut déjà en avoir ouvert un. SQLite refuse une transaction
   * imbriquée, on ne compte donc que la plus extérieure.
   */
  async enBloc(travail: () => Promise<void>): Promise<void> {
    if (this.profondeurBloc > 0) {
      this.profondeurBloc += 1;
      try {
        await travail();
      } finally {
        this.profondeurBloc -= 1;
      }
      return;
    }

    this.profondeurBloc = 1;
    this.base.exec('BEGIN');
    try {
      await travail();
      this.base.exec('COMMIT');
    } catch (erreur) {
      this.base.exec('ROLLBACK');
      throw erreur;
    } finally {
      this.profondeurBloc = 0;
    }
  }

  async fermer(): Promise<void> {
    this.base.close();
  }
}

/**
 * SQLite ne connaît pas `undefined` : une valeur absente est un NULL.
 *
 * Sans cette conversion, un champ facultatif omis fait échouer toute
 * l'insertion — et sur un appareil de terrain, cela voudrait dire une
 * soumission perdue.
 */
function normaliser(parametres: readonly unknown[]): SQLInputValue[] {
  return parametres.map((valeur) => {
    if (valeur === undefined) return null;
    if (typeof valeur === 'boolean') return valeur ? 1 : 0;
    return valeur as SQLInputValue;
  });
}
