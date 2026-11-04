import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

function resolveDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

export function resolveMultiAgentPiWorkingDirectory(workingDir: string): string {
  return resolveDirectory(workingDir);
}

export function resolveMultiAgentPiExtensionDirectories(
  extensionDirs: readonly string[] | undefined,
  workingDir: string,
): string[] {
  return extensionDirs === undefined
    ? [join(workingDir, "extensions")]
    : extensionDirs.map(resolveDirectory);
}

export interface DiscoveredExtensionFile {
  readonly name: string;
  readonly path: string;
}

/** Discover direct extension-directory children using the `<name>/index.ts` convention. */
export function discoverExtensionFiles(extensionsDir: string): DiscoveredExtensionFile[] {
  if (!existsSync(extensionsDir)) return [];

  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({
      name: entry.name,
      path: join(extensionsDir, entry.name, "index.ts"),
    }))
    .filter(extension => existsSync(extension.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}
