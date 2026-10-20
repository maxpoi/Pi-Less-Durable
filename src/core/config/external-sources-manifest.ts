import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { readJsonFile } from "./config-json-utils.js";
import type { ExternalSourcesManifest } from "./config-types.js";

/** Path to the external sources manifest. */
export function getExternalSourcesPath(configDir: string): string {
	return join(configDir, "external-sources.json");
}

/** Read the external sources manifest. Returns empty structure if missing/corrupt. */
export function readExternalSources(configDir: string): ExternalSourcesManifest {
	const path = getExternalSourcesPath(configDir);
	try {
		if (existsSync(path)) {
			const raw = readJsonFile(path);
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { skills: {}, extensions: {} };
			const obj = raw as Record<string, any>;
			return {
				skills: obj.skills && typeof obj.skills === "object" ? obj.skills : {},
				extensions: obj.extensions && typeof obj.extensions === "object" ? obj.extensions : {},
			};
		}
	} catch { /* corrupt */ }
	return { skills: {}, extensions: {} };
}

/** Write the external sources manifest. */
export function writeExternalSources(configDir: string, manifest: ExternalSourcesManifest): void {
	const path = getExternalSourcesPath(configDir);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}
