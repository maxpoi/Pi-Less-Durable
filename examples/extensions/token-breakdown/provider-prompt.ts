interface ProviderPayloadMessage {
	role?: unknown;
	content?: unknown;
}

export interface SerializedProviderSystemMessage {
	source: "messages" | "input";
	index: number;
	role: "system" | "developer";
	content: unknown;
}

function getPayloadRecord(payload: unknown): Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: {};
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (typeof block === "string") return block;
			if (typeof block !== "object" || block === null) return "";
			const record = block as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (typeof record.content === "string") return record.content;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function extractSerializedProviderSystemMessages(payload: unknown): SerializedProviderSystemMessage[] {
	const record = getPayloadRecord(payload);
	const entries: SerializedProviderSystemMessage[] = [];
	for (const source of ["messages", "input"] as const) {
		const messages = record[source];
		if (!Array.isArray(messages)) continue;
		messages.forEach((value, index) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return;
			const message = value as ProviderPayloadMessage;
			if (message.role !== "system" && message.role !== "developer") return;
			entries.push({ source, index, role: message.role, content: message.content });
		});
	}
	return entries;
}

/** Extract every provider-facing system/developer text component in wire order. */
export function extractProviderSystemText(payload: unknown): string {
	const record = getPayloadRecord(payload);
	const parts: string[] = [];
	const topLevelSystem = extractContentText(record.system);
	if (topLevelSystem) parts.push(topLevelSystem);
	if (typeof record.instructions === "string") parts.push(record.instructions);
	for (const message of extractSerializedProviderSystemMessages(record)) {
		const text = extractContentText(message.content);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}
