import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  executeComputerAction,
  type ActionExecutionResult,
} from "./computer-use/executor.js";
import {
  validateComputerAction,
  type ComputerActionParams,
  type InterestedAreaAfterAction,
} from "./computer-use/logic.js";
import {
  captureMainDisplay,
  type ScreenshotCapture,
} from "./screenshot/capture.js";

const screenPixelCoordinate = Type.Integer({
  minimum: 0,
  description: "Pixel coordinate in the latest main-display screenshot",
});

const interestedAreaAfterAction = Type.Object({
  x: screenPixelCoordinate,
  y: screenPixelCoordinate,
  end_x: screenPixelCoordinate,
  end_y: screenPixelCoordinate,
}, {
  description:
    "Anticipated evidence area after the action; x/y are inclusive and end_x/end_y are exclusive pixel bounds in the latest main-display screenshot. A full main-display screenshot is always returned.",
});

const ComputerActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("click"),
    Type.Literal("double_click"),
    Type.Literal("right_click"),
    Type.Literal("move"),
    Type.Literal("drag"),
    Type.Literal("type"),
    Type.Literal("hotkey"),
    Type.Literal("scroll"),
  ], { description: "One atomic computer action to execute" }),
  x: Type.Optional(screenPixelCoordinate),
  y: Type.Optional(screenPixelCoordinate),
  end_x: Type.Optional(screenPixelCoordinate),
  end_y: Type.Optional(screenPixelCoordinate),
  text: Type.Optional(Type.String({
    maxLength: 10_000,
    description: "Text for the type action. Newlines press Enter.",
  })),
  keys: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 100,
    description:
      "Keys for hotkey, such as 'ctrl+l' or 'ctrl shift p'. ctrl/cmd use Cmd on macOS and Ctrl on Windows.",
  })),
  direction: Type.Optional(Type.Union([
    Type.Literal("up"),
    Type.Literal("down"),
    Type.Literal("left"),
    Type.Literal("right"),
  ])),
  amount: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 20,
    description: "Scroll amount in OS-dependent steps. Default: 5",
  })),
  interestedAreaAfterAction: Type.Optional(interestedAreaAfterAction),
});

export interface ComputerActionDetails {
  readonly action: ComputerActionParams["action"];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  interestedAreaAfterAction?: InterestedAreaAfterAction & {
    readonly width: number;
    readonly height: number;
  };
}

export interface ComputerActionToolDependencies {
  readonly execute?: (
    params: ComputerActionParams,
    signal?: AbortSignal,
  ) => Promise<ActionExecutionResult>;
  readonly captureAfterAction?: () => Promise<ScreenshotCapture>;
  readonly waitAfterAction?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly now?: () => Date;
}

export function isComputerActionSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin" || platform === "win32";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionPermissionHint(error: unknown): string {
  const message = errorMessage(error);
  if (process.platform !== "darwin" || error instanceof RangeError) return message;
  return `${message}\n\nOn macOS, grant Accessibility permission to the terminal or Node host process in System Settings > Privacy & Security, then restart it.`;
}

function capturePermissionHint(error: unknown): string {
  const message = errorMessage(error);
  if (process.platform !== "darwin") return message;
  return `${message} Grant Screen Recording permission to the terminal or Node host process in System Settings > Privacy & Security, then restart it.`;
}

export function createComputerActionTool(
  dependencies: ComputerActionToolDependencies = {},
): ToolDefinition<typeof ComputerActionSchema> {
  const execute = dependencies.execute ?? executeComputerAction;
  const captureAfterAction = dependencies.captureAfterAction ?? captureMainDisplay;
  const waitAfterAction = dependencies.waitAfterAction ?? (async (milliseconds, signal) => {
    await sleep(milliseconds, undefined, { signal });
  });
  const now = dependencies.now ?? (() => new Date());
  return {
    name: "computer_action",
    label: "Control computer",
    description:
      "Execute exactly one mouse, keyboard, scroll, or drag action on the native desktop using Nut.js. Use direct pixel coordinates from the latest main-display screenshot. Return the full main-display screenshot after the action.",
    parameters: ComputerActionSchema,
    executionMode: "sequential",
    defaultActive: false,
    promptSnippet: "Execute one native mouse or keyboard action",
    promptGuidelines: [
      "Use computer tools only when the user explicitly asks to inspect or control the local desktop.",
      "Call screenshot for the main display before the first computer_action.",
      "Before each computer action, think one step ahead: anticipate where its result will appear and what visual evidence you will need to choose the next step. Whenever that region is predictable, provide interestedAreaAfterAction using the smallest area from the latest main-display screenshot that still retains enough context.",
      "Use the returned post-action image to decide the next step without taking a separate screenshot when it is sufficient. If the image is incomplete, ambiguous, or misses a UI change, call screenshot before the next action.",
      "Choose targets from the latest main-display screenshot by visible meaning; any 2 consecutive actions may invalidate prior coordinates.",
      "Before purchases, account changes, destructive actions, or sending messages, get explicit user confirmation.",
      "Never enter, reveal, or transmit secrets found on screen unless the user explicitly supplied and authorized them.",
    ],
    async execute(_toolCallId, params, signal) {
      const validationError = validateComputerAction(params);
      if (validationError) throw new Error(`Invalid computer_action: ${validationError}`);

      const startedAt = now();
      let result: ActionExecutionResult;
      try {
        result = await execute(params, signal);
      } catch (error) {
        throw new Error(`computer_action failed: ${actionPermissionHint(error)}`, {
          cause: error,
        });
      }

      const completedAt = now();
      let postActionScreenshot: ScreenshotCapture | undefined;
      let captureFailure: string | undefined;
      try {
        await waitAfterAction(300, signal);
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        captureFailure = errorMessage(error);
      }
      if (captureFailure === undefined) {
        try {
          postActionScreenshot = await captureAfterAction();
          signal?.throwIfAborted();
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          captureFailure = capturePermissionHint(error);
        }
      }

      const details: ComputerActionDetails = {
        action: params.action,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
      if (params.interestedAreaAfterAction !== undefined && postActionScreenshot !== undefined) {
        details.interestedAreaAfterAction = {
          ...params.interestedAreaAfterAction,
          width: postActionScreenshot.width,
          height: postActionScreenshot.height,
        };
      }

      const actionMessage = `${result.message}.\n\nAction ended. If more actions remain, inspect the updated screen before deciding the next action.`;
      const observationMessage = postActionScreenshot
        ? "\n\nFull main-display post-action screenshot:"
        : `\n\nFull main-display post-action screenshot could not be captured: ${captureFailure ?? "unknown error"}`;
      return {
        content: [
          { type: "text" as const, text: `${actionMessage}${observationMessage}` },
          ...(postActionScreenshot === undefined
            ? []
            : [{
                type: "image" as const,
                mimeType: "image/jpeg" as const,
                data: postActionScreenshot.base64,
              }]),
        ],
        details,
      };
    },
  };
}

export {
  executeComputerAction,
  type ActionExecutionResult,
} from "./computer-use/executor.js";
export {
  validateComputerAction,
  type ComputerActionParams,
  type InterestedAreaAfterAction,
} from "./computer-use/logic.js";
