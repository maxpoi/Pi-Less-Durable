import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One extension file currently available for selection by name. */
export interface AvailableExtension {
  readonly name: string;
  readonly file: string;
}

export interface ExtensionFileCollision {
  readonly name: string;
  readonly selectedDirectory: string;
  readonly discardedDirectory: string;
}

export interface AvailableExtensionsResult {
  readonly extensions: readonly AvailableExtension[];
  readonly collisions: readonly ExtensionFileCollision[];
}

export interface AvailableExtensionsOptions {
  readonly extensionDirectories: readonly string[];
  /** Invalidate the Pi module-local cache used to load these files. */
  readonly invalidateFileCache: () => Promise<void>;
}

/** Process-owned list of extension files available for loop selection. */
export class AvailableExtensions {
  readonly #extensionDirectories: readonly string[];
  readonly #invalidateFileCache: () => Promise<void>;
  readonly #disabledNames = new Set<string>();
  #current: AvailableExtensionsResult = Object.freeze({
    extensions: Object.freeze([]),
    collisions: Object.freeze([]),
  });

  constructor(options: AvailableExtensionsOptions) {
    this.#extensionDirectories = Object.freeze([...options.extensionDirectories]);
    this.#invalidateFileCache = options.invalidateFileCache;
  }

  get extensions(): readonly AvailableExtension[] { return this.#current.extensions; }
  get collisions(): readonly ExtensionFileCollision[] { return this.#current.collisions; }
  get disabledNames(): readonly string[] { return Object.freeze([...this.#disabledNames].sort()); }

  disable(name: string): void { this.#disabledNames.add(normalizeExtensionName(name)); }
  enable(name: string): void { this.#disabledNames.delete(normalizeExtensionName(name)); }
  clearDisabled(): void { this.#disabledNames.clear(); }

  async reload(): Promise<AvailableExtensionsResult> {
    const replacement = findAvailableExtensions(this.#extensionDirectories, this.#disabledNames);
    await this.#invalidateFileCache();
    this.#current = replacement;
    return replacement;
  }
}

function normalizeExtensionName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("Extension name must not be empty");
  return normalized;
}

/**
 * Find `<directory>/<name>/extension.ts` files in deterministic order.
 * Later directories replace an earlier file with the same extension name.
 */
export function findAvailableExtensions(
  directories: readonly string[],
  excludedNames: ReadonlySet<string> = new Set(),
): AvailableExtensionsResult {
  const available = new Map<string, { readonly directory: string; readonly file: string }>();
  const collisions: ExtensionFileCollision[] = [];

  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      if (excludedNames.has(entry.name)) continue;
      const extensionFile = join(directory, entry.name, "extension.ts");
      if (!existsSync(extensionFile)) continue;

      const previous = available.get(entry.name);
      if (previous) {
        collisions.push(Object.freeze({
          name: entry.name,
          selectedDirectory: directory,
          discardedDirectory: previous.directory,
        }));
        available.delete(entry.name);
      }
      available.set(entry.name, { directory, file: extensionFile });
    }
  }

  return Object.freeze({
    extensions: Object.freeze([...available].map(([name, extension]) => Object.freeze({
      name,
      file: extension.file,
    }))),
    collisions: Object.freeze(collisions),
  });
}
