import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

function resolveDirectory(path: string): string {
  const unquoted = path.trim().replace(/^["']|["']$/g, "");
  if (unquoted === "~") return homedir();
  if (unquoted.startsWith(`~${sep}`) || unquoted.startsWith("~/")) {
    return join(homedir(), unquoted.slice(2));
  }
  return resolve(unquoted);
}

export function resolveMultiAgentPiWorkingDirectory(workingDir?: string): string {
  const candidate = workingDir?.trim() ? workingDir : join(homedir(), ".multiagentpi");
  return resolveDirectory(candidate);
}

export function resolveMultiAgentPiExtensionsDirectory(
  extensionsDir: string | undefined,
  workingDir: string,
): string {
  return extensionsDir?.trim()
    ? resolveDirectory(extensionsDir)
    : join(workingDir, "extensions");
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
