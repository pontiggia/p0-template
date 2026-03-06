import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';

type CatalogPath = string & { readonly __brand: 'CatalogPath' };

type SemanticCatalogFiles = Map<CatalogPath, string>;

type LoadCatalogResult =
  | { success: true; files: SemanticCatalogFiles }
  | { success: false; error: string };

const CATALOG_PATH: string = path.join(process.cwd(), 'semantic-catalog');

async function walkDir(
  dir: string,
  prefix: string,
  files: SemanticCatalogFiles,
): Promise<void> {
  const entries: Dirent[] = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath: string = path.join(dir, entry.name);
    const relativePath = path.join(prefix, entry.name) as CatalogPath;

    if (entry.isDirectory()) {
      await walkDir(fullPath, relativePath, files);
    } else {
      const content: string = await readFile(fullPath, 'utf-8');
      files.set(relativePath, content);
    }
  }
}

export async function getSemanticCatalogFiles(): Promise<LoadCatalogResult> {
  try {
    const files: SemanticCatalogFiles = new Map();
    await walkDir(CATALOG_PATH, '', files);

    return { success: true, files };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown error loading catalog';
    return { success: false, error: message };
  }
}

export type { CatalogPath, SemanticCatalogFiles, LoadCatalogResult };
