export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result && Array.isArray((result as any).content)) {
    const parts: string[] = [];
    for (const part of (result as any).content) {
      if (part.type === "text" && part.text) parts.push(part.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return JSON.stringify(result);
}
