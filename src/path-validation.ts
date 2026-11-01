import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve, create, and canonicalize one framework persistence directory.
 *
 * Creating the directory first lets the operating system resolve the complete
 * path identity through realpathSync.native(), including aliases and symlinks,
 * without implementing path-identity rules in the framework.
 */
export function resolvePersistenceDirectory(path: string): string {
  const resolvedPath = resolve(path);
  mkdirSync(resolvedPath, { recursive: true });
  return realpathSync.native(resolvedPath);
}

/** Validate one consumer-supplied persistence path before applying defaults or resolution. */
export function assertExplicitPersistencePath(
  path: unknown,
  label: string,
): asserts path is string {
  if (path === undefined) throw new Error(`${label} is required`);
  if (typeof path !== "string") throw new Error(`${label} must be a string`);
  const trimmed = path.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  if (trimmed !== path) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
}

/** Resolve a consumer-supplied persistence directory after validating explicit input. */
export function resolveExplicitPersistenceDirectory(path: string, label: string): string {
  assertExplicitPersistencePath(path, label);
  return resolvePersistenceDirectory(path);
}

/** Return whether either canonical persistence directory contains the other. */
export function persistenceDirectoryTreesOverlap(left: string, right: string): boolean {
  return isDirectoryWithin(left, right) || isDirectoryWithin(right, left);
}

function isDirectoryWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}
