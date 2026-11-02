import {
  Button,
  Key,
  Point,
  keyboard,
  mouse,
  screen,
  straightTo,
} from "@computer-use/nut-js";
import { splitKeyTokens, type ComputerActionParams } from "./logic.js";

const DEFAULT_MOUSE_SPEED = 3600;

function screenPixel(value: number, dimension: number, name: string): number {
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new RangeError(`Screen dimension must be a positive integer, got ${dimension}`);
  }
  if (!Number.isInteger(value) || value < 0 || value >= dimension) {
    throw new RangeError(
      `${name} must be an integer between 0 and ${dimension - 1} for the current screen`,
    );
  }
  return value;
}

function pointFromPixels(x: number, y: number, width: number, height: number): Point {
  return new Point(screenPixel(x, width, "x"), screenPixel(y, height, "y"));
}

function normalizedKeyName(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function resolveKeys(keys: string): Key[] {
  const platformPrimary = process.platform === "darwin" ? Key.LeftCmd : Key.LeftControl;
  const platformMeta = process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin;
  const aliases: Readonly<Record<string, Key>> = {
    ctrl: platformPrimary,
    control: platformPrimary,
    cmd: platformPrimary,
    command: platformPrimary,
    meta: platformMeta,
    win: Key.LeftWin,
    windows: Key.LeftWin,
    shift: Key.LeftShift,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    return: Key.Enter,
    enter: Key.Enter,
    esc: Key.Escape,
    escape: Key.Escape,
    space: Key.Space,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    arrowup: Key.Up,
    arrowdown: Key.Down,
    arrowleft: Key.Left,
    arrowright: Key.Right,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
  };
  const enumKeys = new Map<string, Key>();
  for (const [name, value] of Object.entries(Key)) {
    if (typeof value === "number") enumKeys.set(normalizedKeyName(name), value as Key);
  }
  for (let digit = 0; digit <= 9; digit += 1) {
    enumKeys.set(String(digit), Key[`Num${digit}` as keyof typeof Key] as Key);
  }

  return splitKeyTokens(keys).map(token => {
    const normalized = normalizedKeyName(token);
    const key = aliases[normalized] ?? enumKeys.get(normalized);
    if (key === undefined) throw new Error(`Unsupported key: ${token}`);
    return key;
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Action aborted"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Action aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function typeText(text: string, signal?: AbortSignal): Promise<void> {
  const previousDelay = keyboard.config.autoDelayMs;
  keyboard.config.autoDelayMs = 20;
  try {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      signal?.throwIfAborted();
      const line = lines[index] ?? "";
      if (line) await keyboard.type(line);
      if (index < lines.length - 1) {
        await keyboard.pressKey(Key.Enter);
        await keyboard.releaseKey(Key.Enter);
      }
    }
  } finally {
    keyboard.config.autoDelayMs = previousDelay;
  }
}

export interface ActionExecutionResult {
  readonly message: string;
}

export async function executeComputerAction(
  params: ComputerActionParams,
  signal?: AbortSignal,
): Promise<ActionExecutionResult> {
  signal?.throwIfAborted();
  const width = await screen.width();
  const height = await screen.height();
  signal?.throwIfAborted();
  mouse.config.mouseSpeed = DEFAULT_MOUSE_SPEED;

  const point = () => pointFromPixels(params.x!, params.y!, width, height);
  const moveToPoint = async () => mouse.move(straightTo(point()));

  switch (params.action) {
    case "click":
      await moveToPoint();
      await mouse.click(Button.LEFT);
      break;
    case "double_click":
      await moveToPoint();
      await mouse.doubleClick(Button.LEFT);
      break;
    case "right_click":
      await moveToPoint();
      await mouse.click(Button.RIGHT);
      break;
    case "move":
      await moveToPoint();
      break;
    case "drag": {
      await moveToPoint();
      const end = pointFromPixels(params.end_x!, params.end_y!, width, height);
      await mouse.drag(straightTo(end));
      break;
    }
    case "type":
      await typeText(params.text ?? "", signal);
      break;
    case "hotkey": {
      const keys = resolveKeys(params.keys ?? "");
      await keyboard.pressKey(...keys);
      try {
        await abortableDelay(50, signal);
      } finally {
        await keyboard.releaseKey(...keys);
      }
      break;
    }
    case "scroll": {
      if (params.x !== undefined && params.y !== undefined) await moveToPoint();
      const amount = params.amount ?? 5;
      switch (params.direction) {
        case "up": await mouse.scrollUp(amount); break;
        case "down": await mouse.scrollDown(amount); break;
        case "left": await mouse.scrollLeft(amount); break;
        case "right": await mouse.scrollRight(amount); break;
      }
      break;
    }
  }

  signal?.throwIfAborted();
  return { message: `${params.action} completed` };
}
