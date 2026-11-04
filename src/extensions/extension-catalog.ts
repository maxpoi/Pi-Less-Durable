import type {
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** Named exact file source supplied by the Harness consumer. */
export interface HarnessExtensionFile {
  readonly name: string;
  readonly path: string;
}

/** Named inline source supplied by the Harness consumer and shared by its AgentLoops. */
export type HarnessInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

/** Public immutable description of one Harness extension catalog entry. */
export interface HarnessExtensionCatalogEntry {
  readonly name: string;
  readonly kind: "file" | "inline";
  readonly source: "discovered" | "additional";
  readonly path?: string;
}

/** @internal Executable source retained by the Harness extension catalog. */
export type HarnessExtensionCatalogSource =
  | {
      readonly name: string;
      readonly kind: "file";
      readonly source: "discovered" | "additional";
      readonly path: string;
    }
  | {
      readonly name: string;
      readonly kind: "inline";
      readonly source: "additional";
      readonly extension: HarnessInlineExtension;
    };

export interface HarnessExtensionSelection {
  readonly allowedExtensions?: readonly string[];
  readonly excludedExtensions?: readonly string[];
}

/** @internal Snapshot one AgentLoop's catalog-name selection policy. */
export function createHarnessExtensionMatcher(
  selection: HarnessExtensionSelection,
): (extension: Pick<HarnessExtensionCatalogSource, "name">) => boolean {
  const allowed = selection.allowedExtensions === undefined
    ? undefined
    : new Set(selection.allowedExtensions);
  const excluded = new Set(selection.excludedExtensions ?? []);
  return extension => (allowed?.has(extension.name) ?? true) && !excluded.has(extension.name);
}

/** @internal Read one usable extension name from an untrusted consumer value. */
export function getValidExtensionName(extension: unknown): string | undefined {
  if (!extension || typeof extension !== "object" || !("name" in extension)) {
    return undefined;
  }
  const { name } = extension;
  return typeof name === "string" && name.trim() ? name : undefined;
}

/** @internal Native Pi path assigned to one named inline extension. */
export function getNamedInlineExtensionPath(
  extension: HarnessInlineExtension,
): string {
  return extension.builtin === true
    ? `builtin:${extension.name}`
    : `<inline:${extension.name}>`;
}
