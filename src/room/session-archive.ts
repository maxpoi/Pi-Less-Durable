import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

const CONTEXT_FILE = "context.jsonl";
const ARCHIVED_COMPANION_FILES = Object.freeze([
  "context.meta.json",
  "log.jsonl",
  "MEMORY.md",
  "usage.jsonl",
]);

interface ArchiveDirectory {
  readonly name: string;
  readonly path: string;
}

function pathExistsNoFollow(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isRealDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function isRealFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function ensureSessionsDirectory(roomDir: string): string {
  const sessionsDir = join(roomDir, "sessions");
  if (existsSync(sessionsDir)) {
    if (!isRealDirectory(sessionsDir)) {
      throw new Error("sessions path exists but is not a real directory");
    }
  } else {
    mkdirSync(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

function archiveDirectoryName(
  roomId: string,
  timestamp: string,
  attempt: number,
): string {
  if (attempt === 0) return `${roomId}.${timestamp}`;
  return `${roomId}-${attempt}.${timestamp}`;
}

function archiveAttemptFromDirectoryName(
  directoryName: string,
  roomId: string,
  timestamp: string,
): number | undefined {
  if (directoryName === archiveDirectoryName(roomId, timestamp, 0)) return 0;
  const suffix = `.${timestamp}`;
  if (!directoryName.endsWith(suffix)) return undefined;

  const prefix = directoryName.slice(0, -suffix.length);
  const duplicatePrefix = `${roomId}-`;
  if (!prefix.startsWith(duplicatePrefix)) return undefined;

  const attempt = Number(prefix.slice(duplicatePrefix.length));
  return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function findNextAttempt(
  sessionsDir: string,
  roomId: string,
  timestamp: string,
): number {
  let maxAttempt = -1;
  for (const directoryName of readdirSync(sessionsDir)) {
    const attempt = archiveAttemptFromDirectoryName(directoryName, roomId, timestamp);
    if (attempt !== undefined && attempt > maxAttempt) maxAttempt = attempt;
  }
  return maxAttempt + 1;
}

function createArchiveDirectory(
  sessionsDir: string,
  roomId: string,
  timestamp: string,
): ArchiveDirectory {
  for (let retry = 0; retry < 10; retry++) {
    const attempt = findNextAttempt(sessionsDir, roomId, timestamp);
    const name = archiveDirectoryName(roomId, timestamp, attempt);
    const path = join(sessionsDir, name);
    if (pathExistsNoFollow(path)) continue;
    try {
      mkdirSync(path);
      if (isRealDirectory(path)) return { name, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to create a unique session archive directory after concurrent collisions");
}

function renameIfRealFile(source: string, destination: string): void {
  if (isRealFile(source)) renameSync(source, destination);
}

/** Archive the settled active Room session after all registered AgentLoops are destroyed. */
export function archiveRoomSession(
  roomDir: string,
  roomId: string,
): string | undefined {
  const contextFile = join(roomDir, CONTEXT_FILE);
  if (pathExistsNoFollow(contextFile) && !isRealFile(contextFile)) {
    throw new Error(`${CONTEXT_FILE} exists but is not a real file`);
  }
  for (const fileName of ARCHIVED_COMPANION_FILES) {
    const path = join(roomDir, fileName);
    if (pathExistsNoFollow(path) && !isRealFile(path)) {
      throw new Error(`${fileName} exists but is not a real file`);
    }
  }
  const loopsDir = join(roomDir, "loops");
  if (pathExistsNoFollow(loopsDir) && !isRealDirectory(loopsDir)) {
    throw new Error("loops path exists but is not a real directory");
  }
  const hasArchivableState = isRealFile(contextFile)
    || ARCHIVED_COMPANION_FILES.some(fileName => isRealFile(join(roomDir, fileName)))
    || isRealDirectory(loopsDir);
  if (!hasArchivableState) return undefined;

  const sessionsDir = ensureSessionsDirectory(roomDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = createArchiveDirectory(sessionsDir, roomId, timestamp);

  renameIfRealFile(contextFile, join(archive.path, CONTEXT_FILE));
  for (const fileName of ARCHIVED_COMPANION_FILES) {
    renameIfRealFile(join(roomDir, fileName), join(archive.path, fileName));
  }
  if (isRealDirectory(loopsDir)) {
    renameSync(loopsDir, join(archive.path, "loops"));
  }
  return archive.name;
}
