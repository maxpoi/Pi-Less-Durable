import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";

export interface PiExtensionLoaderOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly selectedExtensionFiles: readonly string[];
  readonly extensionFactories?: readonly InlineExtension[];
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly transformExtensions?: (result: LoadExtensionsResult) => LoadExtensionsResult;
}

/** Construct a Pi loader for exactly the extension files selected by the owner. */
export function createPiExtensionLoader(
  options: PiExtensionLoaderOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager as any,
    additionalExtensionPaths: [...options.selectedExtensionFiles],
    extensionFactories: [...(options.extensionFactories ?? [])],
    ...(options.transformExtensions === undefined
      ? {}
      : { extensionsOverride: options.transformExtensions }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    eventBus: createEventBus(),
  });
}

/** Invalidate the Pi module-local cache consumed by `createPiExtensionLoader`. */
export async function invalidatePiExtensionFileCache(options: {
  readonly cwd: string;
  readonly agentDir: string;
}): Promise<void> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    eventBus: createEventBus(),
  });
  // Pi clears this module-local cache only when an already-loaded loader reloads.
  await loader.reload();
  await loader.reload();
}
