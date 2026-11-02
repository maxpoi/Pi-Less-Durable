export const COMPUTER_ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "type",
  "hotkey",
  "scroll",
] as const;

export type ComputerActionName = typeof COMPUTER_ACTIONS[number];
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface InterestedAreaAfterAction {
  readonly x: number;
  readonly y: number;
  readonly end_x: number;
  readonly end_y: number;
}

export interface ComputerActionParams {
  readonly action: ComputerActionName;
  readonly x?: number;
  readonly y?: number;
  readonly end_x?: number;
  readonly end_y?: number;
  readonly text?: string;
  readonly keys?: string;
  readonly direction?: ScrollDirection;
  readonly amount?: number;
  readonly interestedAreaAfterAction?: InterestedAreaAfterAction;
}

function hasCoordinatePair(x: number | undefined, y: number | undefined): boolean {
  return x !== undefined && y !== undefined;
}

export function splitKeyTokens(keys: string): string[] {
  return keys
    .trim()
    .split(/[+\s]+/)
    .map(key => key.trim().toLowerCase())
    .filter(Boolean);
}

export function validateComputerAction(params: ComputerActionParams): string | undefined {
  if (!COMPUTER_ACTIONS.includes(params.action)) {
    return `Unsupported action: ${String(params.action)}`;
  }

  const pointActions: ComputerActionName[] = ["click", "double_click", "right_click", "move"];
  if (pointActions.includes(params.action) && !hasCoordinatePair(params.x, params.y)) {
    return `${params.action} requires x and y`;
  }
  if (params.action === "drag") {
    if (!hasCoordinatePair(params.x, params.y)
      || !hasCoordinatePair(params.end_x, params.end_y)) {
      return "drag requires x, y, end_x, and end_y";
    }
  }

  for (const [name, value] of Object.entries({
    x: params.x,
    y: params.y,
    end_x: params.end_x,
    end_y: params.end_y,
  })) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return `${name} must be a non-negative integer pixel coordinate`;
    }
  }

  const area = params.interestedAreaAfterAction;
  if (area) {
    for (const name of ["x", "y", "end_x", "end_y"] as const) {
      const value = area[name];
      if (!Number.isInteger(value) || value < 0) {
        return `interestedAreaAfterAction ${name} must be a non-negative integer pixel coordinate`;
      }
    }
    if (area.x >= area.end_x) {
      return "interestedAreaAfterAction x must be less than end_x";
    }
    if (area.y >= area.end_y) {
      return "interestedAreaAfterAction y must be less than end_y";
    }
  }

  if (params.action === "type" && params.text === undefined) return "type requires text";
  if (params.text !== undefined && params.text.length > 10_000) {
    return "text must not exceed 10000 characters";
  }
  if (params.action === "hotkey") {
    const keyTokens = splitKeyTokens(params.keys ?? "");
    if (keyTokens.length === 0) {
      return "hotkey requires keys, for example 'cmd+l' or 'ctrl shift p'";
    }
    if (keyTokens.length > 4) return "hotkey supports at most 4 keys";
  }
  if (params.action === "scroll" && !params.direction) {
    return "scroll requires direction";
  }
  if ((params.x === undefined) !== (params.y === undefined)) {
    return "x and y must be provided together";
  }
  if (params.amount !== undefined
    && (!Number.isInteger(params.amount) || params.amount < 1 || params.amount > 20)) {
    return "amount must be an integer between 1 and 20";
  }
  return undefined;
}
