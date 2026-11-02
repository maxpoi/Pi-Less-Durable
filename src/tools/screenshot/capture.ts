import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screen } from "@computer-use/nut-js";
import sharp from "sharp";
import { runLocalProcess } from "./process-exec.js";

export const SCREENSHOT_DIRECTORY = process.platform === "win32"
  ? join(tmpdir(), "pi-less-durable-screenshots")
  : "/tmp/pi-less-durable-screenshots";

export interface ScreenshotCapture {
  readonly data: Buffer;
  readonly base64: string;
  readonly width: number;
  readonly height: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly pixelDensity: number | { scaleX: number; scaleY: number };
  readonly sizeBytes: number;
}

export interface ScreenshotCropArea {
  readonly x: number;
  readonly y: number;
  readonly end_x: number;
  readonly end_y: number;
}

export interface CroppedScreenshot {
  readonly data: Buffer;
  readonly base64: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

export function isScreenshotSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export async function saveScreenshot(
  capture: Pick<ScreenshotCapture, "data">,
  directory = SCREENSHOT_DIRECTORY,
  timestamp = Date.now(),
): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const filename = `screenshot-${timestamp}${suffix}.jpg`;
    const imagePath = join(directory, filename);
    try {
      await writeFile(imagePath, capture.data, { flag: "wx" });
      return imagePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function buildWindowsScreenshotProcess(
  rawPngPath: string,
  display: number,
): { executable: string; args: string[] } {
  const outputPath = rawPngPath.replace(/'/g, "''");
  const displayIndex = display - 1;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$screens = @([System.Windows.Forms.Screen]::AllScreens);",
    "$primary = [System.Windows.Forms.Screen]::PrimaryScreen;",
    "$ordered = @($primary) + @($screens | Where-Object { $_.DeviceName -ne $primary.DeviceName });",
    `$displayIndex = ${displayIndex};`,
    `if ($displayIndex -lt 0 -or $displayIndex -ge $ordered.Count) { throw 'Display ${display} is not available.'; }`,
    "$bounds = $ordered[$displayIndex].Bounds;",
    "$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);",
    "$g = [System.Drawing.Graphics]::FromImage($bmp);",
    "try {",
    "$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);",
    `$bmp.Save('${outputPath}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "} finally { $g.Dispose(); $bmp.Dispose(); }",
  ].join(" ");
  return { executable: "powershell", args: ["-NoProfile", "-Command", script] };
}

export async function encodeNativeCapture(rawPng: Buffer): Promise<ScreenshotCapture> {
  const { data, info } = await sharp(rawPng)
    .rotate()
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    base64: data.toString("base64"),
    width: info.width,
    height: info.height,
    logicalWidth: info.width,
    logicalHeight: info.height,
    pixelDensity: 1,
    sizeBytes: data.length,
  };
}

export async function captureNativeDisplay(display: number): Promise<ScreenshotCapture> {
  const rawPngPath = join(tmpdir(), `pi-less-durable-screenshot-${Date.now()}.png`);
  try {
    const processSpec = process.platform === "darwin"
      ? { executable: "/usr/sbin/screencapture", args: ["-x", "-D", String(display), rawPngPath] }
      : process.platform === "win32"
        ? buildWindowsScreenshotProcess(rawPngPath, display)
        : undefined;
    if (!processSpec) {
      throw new Error(`Native display capture is not supported on ${process.platform}`);
    }
    const result = await runLocalProcess(processSpec.executable, processSpec.args, {
      timeout: 15_000,
    });
    if (result.code !== 0) {
      throw new Error(
        `Native display capture failed (code ${result.code}): ${result.stderr.trim() || "unknown error"}`,
      );
    }
    return encodeNativeCapture(await readFile(rawPngPath));
  } finally {
    await unlink(rawPngPath).catch(() => {});
  }
}

export async function captureMainDisplay(): Promise<ScreenshotCapture> {
  const grabbed = await screen.grab();
  const rgb = await grabbed.toRGB();
  if (rgb.channels !== 3 && rgb.channels !== 4) {
    throw new Error(`Unsupported screenshot channel count: ${rgb.channels}`);
  }

  const logicalWidth = await screen.width();
  const logicalHeight = await screen.height();
  const { data, info } = await sharp(rgb.data, {
    raw: {
      width: rgb.width,
      height: rgb.height,
      channels: rgb.channels,
    },
  })
    .resize({ width: logicalWidth, height: logicalHeight, fit: "fill" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    base64: data.toString("base64"),
    width: info.width,
    height: info.height,
    logicalWidth,
    logicalHeight,
    pixelDensity: grabbed.pixelDensity,
    sizeBytes: data.length,
  };
}

export async function cropScreenshot(
  capture: Pick<ScreenshotCapture, "data" | "width" | "height">,
  area: ScreenshotCropArea,
): Promise<CroppedScreenshot> {
  const bounds = [area.x, area.y, area.end_x, area.end_y];
  if (bounds.some(value => !Number.isInteger(value) || value < 0)) {
    throw new RangeError("Interested area bounds must be non-negative integer pixel coordinates");
  }
  if (area.x >= area.end_x || area.y >= area.end_y) {
    throw new RangeError("Interested area must have positive width and height");
  }
  if (area.end_x > capture.width || area.end_y > capture.height) {
    throw new RangeError(
      `Interested area (${area.x},${area.y})-(${area.end_x},${area.end_y}) exceeds screenshot bounds ${capture.width}x${capture.height}`,
    );
  }
  const { data, info } = await sharp(capture.data)
    .extract({
      left: area.x,
      top: area.y,
      width: area.end_x - area.x,
      height: area.end_y - area.y,
    })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    base64: data.toString("base64"),
    width: info.width,
    height: info.height,
    sizeBytes: data.length,
  };
}
