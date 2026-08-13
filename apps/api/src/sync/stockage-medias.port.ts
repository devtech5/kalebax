import { createHash } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

/**
 * Stockage des pièces jointes.
 *
 * Un port, parce que la production ira vers un stockage objet dont
 * l'emplacement est maîtrisé et communicable au client — argument décisif pour
 * les bailleurs — tandis que le développement et les tests se contentent du
 * disque local ou de la mémoire.
 */
export interface StockageMedias {
  /** Octets déjà détenus. Zéro si le média est inconnu. */
  taille(cle: string): Promise<number>;
  /**
   * Écrit un morceau à un offset et rend la nouvelle taille.
   *
   * Un offset qui ne correspond pas à la taille courante est refusé : accepter
   * un trou produirait un fichier de la bonne longueur mais au contenu faux, ce
   * que le checksum final ne rattraperait qu'après un envoi complet inutile.
   */
  ecrireA(cle: string, offset: number, donnees: Uint8Array): Promise<number>;
  /** SHA-256 du contenu détenu, pour vérifier l'intégrité au scellement. */
  empreinte(cle: string): Promise<string>;
  supprimer(cle: string): Promise<void>;
}

export const STOCKAGE_MEDIAS = Symbol('StockageMedias');

export class OffsetInvalideError extends Error {
  constructor(readonly attendu: number, readonly recu: number) {
    super(`Morceau attendu à l'octet ${attendu}, reçu à ${recu}.`);
    this.name = 'OffsetInvalideError';
  }
}

/**
 * Stockage sur disque local — développement et poste régional.
 *
 * L'empreinte est calculée en flux : une photo de plusieurs mégaoctets n'a
 * aucune raison de passer entièrement en mémoire, et sur un serveur qui reçoit
 * les envois de cinquante agents, la différence n'est pas théorique.
 */
@Injectable()
export class StockageMediasDisque implements StockageMedias {
  constructor(private readonly racine: string = join(process.cwd(), '.medias')) {}

  private chemin(cle: string): string {
    // Une clé venue du réseau ne doit jamais pouvoir remonter hors de la racine.
    const complet = resolve(this.racine, cle);
    if (!complet.startsWith(resolve(this.racine))) {
      throw new Error('Clé de média invalide.');
    }
    return complet;
  }

  async taille(cle: string): Promise<number> {
    try {
      return (await stat(this.chemin(cle))).size;
    } catch {
      return 0;
    }
  }

  async ecrireA(cle: string, offset: number, donnees: Uint8Array): Promise<number> {
    const courante = await this.taille(cle);
    if (offset !== courante) throw new OffsetInvalideError(courante, offset);

    const chemin = this.chemin(cle);
    await mkdir(dirname(chemin), { recursive: true });
    const fichier = await open(chemin, offset === 0 ? 'w' : 'r+');
    try {
      await fichier.write(donnees, 0, donnees.byteLength, offset);
    } finally {
      await fichier.close();
    }
    return offset + donnees.byteLength;
  }

  async empreinte(cle: string): Promise<string> {
    const condensat = createHash('sha256');
    for await (const bloc of createReadStream(this.chemin(cle))) {
      condensat.update(bloc as Buffer);
    }
    return condensat.digest('hex');
  }

  async supprimer(cle: string): Promise<void> {
    await rm(this.chemin(cle), { force: true });
  }
}

/** Stockage en mémoire, pour les tests. */
export class StockageMediasMemoire implements StockageMedias {
  private readonly fichiers = new Map<string, Buffer>();

  async taille(cle: string): Promise<number> {
    return this.fichiers.get(cle)?.byteLength ?? 0;
  }

  async ecrireA(cle: string, offset: number, donnees: Uint8Array): Promise<number> {
    const courant = this.fichiers.get(cle) ?? Buffer.alloc(0);
    if (offset !== courant.byteLength) {
      throw new OffsetInvalideError(courant.byteLength, offset);
    }
    const fusionne = Buffer.concat([courant, Buffer.from(donnees)]);
    this.fichiers.set(cle, fusionne);
    return fusionne.byteLength;
  }

  async empreinte(cle: string): Promise<string> {
    const contenu = this.fichiers.get(cle) ?? Buffer.alloc(0);
    return createHash('sha256').update(contenu).digest('hex');
  }

  async supprimer(cle: string): Promise<void> {
    this.fichiers.delete(cle);
  }
}
