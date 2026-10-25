import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Discover direct config extension children using the `<name>/index.ts` convention. */
export function discoverConfigExtensionFiles(configDir: string): string[] {
  const extensionDir = join(configDir, "extensions");
  if (!existsSync(extensionDir)) return [];

  return readdirSync(extensionDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => join(extensionDir, entry.name, "index.ts"))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right));
}
