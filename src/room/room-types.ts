import type { ImageContent } from "@earendil-works/pi-ai";

declare const roomIdBrand: unique symbol;

export type RoomId = string & { readonly [roomIdBrand]: "RoomId" };
export type RoomState = "open" | "reloading" | "closed";

export interface RoomPromptOptions {
  readonly agentId?: string;
  readonly images?: readonly ImageContent[];
}
