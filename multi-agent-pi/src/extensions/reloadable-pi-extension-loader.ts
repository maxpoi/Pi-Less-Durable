import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Stable Pi ResourceLoader identity whose concrete delegate is replaced on reload.
 * The owning session selects extension files; this class remembers that selection.
 */
export abstract class ReloadablePiExtensionLoader implements ResourceLoader {
  #selectedExtensionFiles: string[];
  #current: ResourceLoader | undefined;

  protected constructor(selectedExtensionFiles: readonly string[] = []) {
    this.#selectedExtensionFiles = [...selectedExtensionFiles];
  }

  setSelectedExtensionFiles(files: readonly string[]): void {
    this.#selectedExtensionFiles = [...files];
  }

  async reload(options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    const replacement = this.createDelegate([...this.#selectedExtensionFiles]);
    await replacement.reload(options);
    this.#current = replacement;
  }

  getExtensions(): ReturnType<ResourceLoader["getExtensions"]> {
    return this.current.getExtensions();
  }

  getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return this.current.getSkills();
  }

  getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return this.current.getPrompts();
  }

  getThemes(): ReturnType<ResourceLoader["getThemes"]> {
    return this.current.getThemes();
  }

  getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
    return this.current.getAgentsFiles();
  }

  getSystemPrompt(): string | undefined {
    return this.current.getSystemPrompt();
  }

  getSystemPromptSource(): ReturnType<ResourceLoader["getSystemPromptSource"]> {
    return this.current.getSystemPromptSource();
  }

  getAppendSystemPrompt(): string[] {
    return this.current.getAppendSystemPrompt();
  }

  getAppendSystemPromptSources(): ReturnType<ResourceLoader["getAppendSystemPromptSources"]> {
    return this.current.getAppendSystemPromptSources();
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    this.current.extendResources(paths);
  }

  protected abstract createDelegate(selectedExtensionFiles: readonly string[]): ResourceLoader;

  protected get current(): ResourceLoader {
    if (!this.#current) {
      throw new Error("Extension files have not been loaded into Pi");
    }
    return this.#current;
  }
}
