import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

const SESSIONS_DIRECTORY = "sessions";
const CURRENT_SESSION_DIRECTORY = "current";

export interface RoomSessionArchive {
  readonly name: string;
}

function pathExistsNoFollow(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isRealDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function roomSessionsDirectory(roomDir: string): string {
  return join(roomDir, SESSIONS_DIRECTORY);
}

function ensureRoomSessionsDirectory(roomDir: string): string {
  const sessionsDir = roomSessionsDirectory(roomDir);
  if (!pathExistsNoFollow(sessionsDir)) {
    mkdirSync(sessionsDir);
    return sessionsDir;
  }
  if (!isRealDirectory(sessionsDir)) {
    throw new Error(`${SESSIONS_DIRECTORY} path exists but is not a real directory`);
  }
  return sessionsDir;
}

export function currentRoomSessionDirectory(roomDir: string): string {
  return join(roomSessionsDirectory(roomDir), CURRENT_SESSION_DIRECTORY);
}

/** Ensure the Room has exactly one active `sessions/current` conversation directory. */
export function ensureCurrentRoomSessionDirectory(roomDir: string): string {
  const sessionsDir = ensureRoomSessionsDirectory(roomDir);
  const currentDir = join(sessionsDir, CURRENT_SESSION_DIRECTORY);
  if (!pathExistsNoFollow(currentDir)) {
    mkdirSync(currentDir);
    return currentDir;
  }
  if (!isRealDirectory(currentDir)) {
    throw new Error(`${CURRENT_SESSION_DIRECTORY} path exists but is not a real directory`);
  }
  return currentDir;
}

function assertArchiveName(archiveName: string): void {
  if (
    archiveName.length === 0
    || archiveName === "."
    || archiveName === ".."
    || archiveName === CURRENT_SESSION_DIRECTORY
    || archiveName.includes("/")
    || archiveName.includes("\\")
    || archiveName.includes("\0")
  ) {
    throw new Error(`Invalid Room session archive name: "${archiveName}"`);
  }
}

function resolveArchiveDirectory(roomDir: string, archiveName: string): string {
  assertArchiveName(archiveName);
  const sessionsDir = roomSessionsDirectory(roomDir);
  if (!isRealDirectory(sessionsDir)) {
    throw new Error(`${SESSIONS_DIRECTORY} path does not exist as a real directory`);
  }
  const archiveDir = join(sessionsDir, archiveName);
  if (!isRealDirectory(archiveDir)) {
    throw new Error(`Room session archive "${archiveName}" does not exist`);
  }
  return archiveDir;
}

function findAvailableArchiveName(sessionsDir: string, baseName: string): string {
  const existingNames = new Set(readdirSync(sessionsDir));
  if (!existingNames.has(baseName)) return baseName;

  for (let suffix = 1; ; suffix++) {
    const candidate = `${baseName} (${suffix})`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

/** List archived conversation directories under `sessions`, newest first. */
export function listRoomSessionArchives(roomDir: string): readonly RoomSessionArchive[] {
  const sessionsDir = roomSessionsDirectory(roomDir);
  if (!pathExistsNoFollow(sessionsDir)) return Object.freeze([]);
  if (!isRealDirectory(sessionsDir)) {
    throw new Error(`${SESSIONS_DIRECTORY} path exists but is not a real directory`);
  }

  const archives = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(entry => entry.name !== CURRENT_SESSION_DIRECTORY && entry.isDirectory())
    .map(entry => {
      const archiveDir = resolveArchiveDirectory(roomDir, entry.name);
      return {
        modifiedAtMs: lstatSync(archiveDir).mtimeMs,
        archive: Object.freeze({ name: entry.name }),
      };
    })
    .sort((left, right) =>
      right.modifiedAtMs - left.modifiedAtMs
      || right.archive.name.localeCompare(left.archive.name)
    )
    .map(entry => entry.archive);
  return Object.freeze(archives);
}

/** Validate an exact archive directory reference before Room lifecycle mutation begins. */
export function assertRoomSessionArchiveRestorable(
  roomDir: string,
  archiveName: string,
): void {
  resolveArchiveDirectory(roomDir, archiveName);
}

/** Rename the complete active conversation directory into a sibling archive. */
export function archiveRoomSession(
  roomDir: string,
  roomId: string,
): string {
  const sessionsDir = roomSessionsDirectory(roomDir);
  if (!isRealDirectory(sessionsDir)) {
    throw new Error(`${SESSIONS_DIRECTORY} path does not exist as a real directory`);
  }
  const currentDir = currentRoomSessionDirectory(roomDir);
  if (!isRealDirectory(currentDir)) {
    throw new Error(`${CURRENT_SESSION_DIRECTORY} path does not exist as a real directory`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${roomId}.${timestamp}`;
  const archiveName = findAvailableArchiveName(sessionsDir, baseName);
  renameSync(currentDir, join(sessionsDir, archiveName));
  return archiveName;
}

/** Consume one archive by renaming its complete conversation directory to `current`. */
export function restoreRoomSessionArchive(
  roomDir: string,
  archiveName: string,
): void {
  const archiveDir = resolveArchiveDirectory(roomDir, archiveName);
  const currentDir = currentRoomSessionDirectory(roomDir);
  if (pathExistsNoFollow(currentDir)) {
    throw new Error(`Cannot restore Room session archive "${archiveName}": current already exists`);
  }
  renameSync(archiveDir, currentDir);
}
