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

export function resolveMultiAgentPiExtensionsDirectory(
  extensionsDir: string | undefined,
  workingDir: string,
): string {
  return extensionsDir === undefined
    ? join(workingDir, "extensions")
    : resolveDirectory(extensionsDir);
}

/** Discover direct extension-directory children using the `<name>/index.ts` convention. */
export function discoverExtensionFiles(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) return [];

  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => join(extensionsDir, entry.name, "index.ts"))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right));
}
