import { readFileSync } from "fs";

export function readJsonFile(path: string): unknown {
	const content = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
	return JSON.parse(content);
}

export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const result = { ...a };
	for (const key of Object.keys(b)) {
		const aVal = a[key];
		const bVal = b[key];
		if (
			typeof aVal === "object" && aVal !== null && !Array.isArray(aVal) &&
			typeof bVal === "object" && bVal !== null && !Array.isArray(bVal)
		) {
			result[key] = deepMerge(aVal as Record<string, unknown>, bVal as Record<string, unknown>);
		} else {
			result[key] = bVal;
		}
	}
	return result;
}
