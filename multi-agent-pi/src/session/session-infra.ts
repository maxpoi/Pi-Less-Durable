export interface SessionPaths {
  /** Execution working directory passed to Pi. Prompt presentation remains host-controlled. */
  readonly cwd: string;
  readonly sessionDir: string;
  readonly configDir: string;
}

/**
 * Transport-neutral state shared by every execution in one logical session.
 * Each host supplies its concrete model and resource services while
 * preserving the same ownership shape.
 */
export interface SessionInfra<
  TSessionId extends string = string,
  TModelState = unknown,
  TResourceState = unknown,
> {
  readonly id: TSessionId;
  readonly paths: SessionPaths;
  readonly models: TModelState;
  readonly resources: TResourceState;
}
