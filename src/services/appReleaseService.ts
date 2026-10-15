import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";

export type AppTarget = "customer" | "rider";

export interface AppReleaseInfo {
  target: AppTarget;
  appName: string;
  packageName: string;
  version: string;
  minAndroid: string;
  fileSize: string;
  fileSizeBytes: number;
  fileName: string;
  downloadUrl: string;
  updatedAt: string;
  whatsNew: string[];
  features?: string[];
  fixes?: string[];
  logs?: string[];
  sha256?: string;
}

export interface AppReleasesConfig {
  customer: AppReleaseInfo;
  rider: AppReleaseInfo;
}

const CONFIG_FILE_PATH = path.join(process.cwd(), "config", "app-releases.json");
const CHUNKS_BASE_DIR = path.join(process.cwd(), "config", "uploads", "chunks");

/**
 * Periodically purge stale chunk staging directories older than 2 hours.
 */
async function cleanStaleChunks(): Promise<void> {
  try {
    if (!existsSync(CHUNKS_BASE_DIR)) return;
    const entries = await fs.readdir(CHUNKS_BASE_DIR, { withFileTypes: true });
    const now = Date.now();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(CHUNKS_BASE_DIR, entry.name);
        const stats = await fs.stat(dirPath).catch(() => null);
        if (stats && now - stats.mtimeMs > TWO_HOURS_MS) {
          await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.warn("[AppReleaseService] Failed to clean stale chunk dirs:", err);
  }
}

const DEFAULT_RELEASES: AppReleasesConfig = {
  customer: {
    target: "customer",
    appName: "Sugo Express",
    packageName: "com.sugo.customer",
    version: "1.0.0",
    minAndroid: "Android 8.0+",
    fileSize: "125 MB",
    fileSizeBytes: 130863854,
    fileName: "sugo-customer-app.apk",
    downloadUrl: "/downloads/sugo-customer-app.apk",
    updatedAt: "2026-10-08T00:00:00.000Z",
    whatsNew: [
      "Create on-demand Pabili errands for food, market produce, or medicine",
      "Watch your rider move in real time on the Tacurong road map",
      "View itemized store receipts photographed before delivery handover",
      "Chat directly with your assigned rider without sharing private phone numbers",
    ],
    features: [
      "Create on-demand Pabili errands for food, market produce, or medicine",
      "Watch your rider move in real time on the Tacurong road map",
      "View itemized store receipts photographed before delivery handover",
      "Chat directly with your assigned rider without sharing private phone numbers",
    ],
    fixes: [
      "Optimized location permission timing on Android 14",
      "Enhanced real-time connection resilience during network drops",
    ],
    logs: [
      "Expo SDK 57 runtime stabilization",
      "In-memory session token refresh optimization",
    ],
  },
  rider: {
    target: "rider",
    appName: "Sugo Rider",
    packageName: "com.sugo.rider",
    version: "1.0.0",
    minAndroid: "Android 8.0+",
    fileSize: "173 MB",
    fileSizeBytes: 181316404,
    fileName: "sugo-rider-app.apk",
    downloadUrl: "/downloads/sugo-rider-app.apk",
    updatedAt: "2026-10-08T00:00:00.000Z",
    whatsNew: [
      "Instant dispatch alerts with store locations and item shopping lists",
      "Road-network turn-by-turn routing with daylight high-contrast HUD",
      "Quick camera capture for receipts and proof of delivery handover",
      "Clear errand history, completed trip ledger, and earnings tracker",
    ],
    features: [
      "Instant dispatch alerts with store locations and item shopping lists",
      "Road-network turn-by-turn routing with daylight high-contrast HUD",
      "Quick camera capture for receipts and proof of delivery handover",
      "Clear errand history, completed trip ledger, and earnings tracker",
    ],
    fixes: [
      "Eliminated foreground background location task refresh loops in dev mode",
      "Fixed turn-by-turn HUD vertical stacking overlap",
    ],
    logs: [
      "3D third-person chase cam tilt calibration",
      "Road-network centerline snapping precision boost",
    ],
  },
};

let releasesState: AppReleasesConfig = {
  customer: { ...DEFAULT_RELEASES.customer },
  rider: { ...DEFAULT_RELEASES.rider },
};

/**
 * Determine the destination directory for APK downloads.
 * Prioritizes landing page downloads path so sugoonthego.online serves it immediately.
 */
function getDownloadDirectories(): string[] {
  const dirs: string[] = [];

  // 1. Authoritative server public downloads directory (persistent release storage)
  const serverPublicDownloads = path.resolve(process.cwd(), "public", "downloads");
  if (existsSync(serverPublicDownloads)) {
    dirs.push(serverPublicDownloads);
  }

  // 2. VPS Production path for sugoonthego.online static downloads
  const vpsLandingDownloads = "/var/www/landing/dist/downloads";
  if (existsSync("/var/www/landing")) {
    dirs.push(vpsLandingDownloads);
  }

  // 3. Local development checkout path for Capstone_Landing_Page
  const localLandingDownloads = path.resolve(process.cwd(), "..", "..", "Capstone_Landing_Page", "public", "downloads");
  if (existsSync(path.dirname(localLandingDownloads))) {
    dirs.push(localLandingDownloads);
  }

  if (!dirs.includes(serverPublicDownloads)) {
    dirs.push(serverPublicDownloads);
  }

  return dirs;
}

export async function loadAppReleases(): Promise<AppReleasesConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.customer) {
      releasesState.customer = { ...DEFAULT_RELEASES.customer, ...parsed.customer };
    }
    if (parsed?.rider) {
      releasesState.rider = { ...DEFAULT_RELEASES.rider, ...parsed.rider };
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn("[AppReleaseService] Error loading app-releases.json from disk:", err);
    } else {
      await saveAppReleases();
    }
  }
  return releasesState;
}

export async function saveAppReleases(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
    const tempFile = `${CONFIG_FILE_PATH}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(releasesState, null, 2), "utf-8");
    await fs.rename(tempFile, CONFIG_FILE_PATH);
  } catch (err) {
    logger.error("[AppReleaseService] Failed to persist app-releases.json:", err);
    throw err;
  }
}

export function getPublicReleases(): { customer: AppReleaseInfo; rider: AppReleaseInfo } {
  return {
    customer: { ...releasesState.customer },
    rider: { ...releasesState.rider },
  };
}

export function getSysAdminReleases(): AppReleasesConfig {
  return { ...releasesState };
}

export interface UpdateReleaseInput {
  version?: string;
  minAndroid?: string;
  fileSize?: string;
  whatsNew?: string[];
  features?: string[];
  fixes?: string[];
  logs?: string[];
}

export async function updateReleaseDetails(
  target: AppTarget,
  input: UpdateReleaseInput
): Promise<AppReleaseInfo> {
  const current = releasesState[target];
  if (!current) {
    throw new Error(`Invalid app release target: ${target}`);
  }

  if (input.version !== undefined && input.version.trim()) {
    current.version = input.version.trim();
  }
  if (input.minAndroid !== undefined && input.minAndroid.trim()) {
    current.minAndroid = input.minAndroid.trim();
  }
  if (input.fileSize !== undefined && input.fileSize.trim()) {
    current.fileSize = input.fileSize.trim();
  }
  if (Array.isArray(input.features)) {
    current.features = input.features
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (Array.isArray(input.fixes)) {
    current.fixes = input.fixes
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (Array.isArray(input.logs)) {
    current.logs = input.logs
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (Array.isArray(input.whatsNew) && input.whatsNew.length > 0) {
    current.whatsNew = input.whatsNew
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  } else if (current.features && current.features.length > 0) {
    // Synthesize whatsNew from features and fixes if whatsNew is empty or omitted
    current.whatsNew = [
      ...current.features,
      ...(current.fixes || []).map((f) => `Fix: ${f}`),
    ];
  }

  current.updatedAt = new Date().toISOString();
  releasesState[target] = current;

  await saveAppReleases();

  try {
    eventPublisher.emit("system:app_releases_update", releasesState);
  } catch (emitErr) {
    logger.warn("[AppReleaseService] Failed to emit Socket.IO release update:", emitErr);
  }

  return current;
}

/**
 * Handle streaming APK upload directly to disk without loading entire payload into RAM.
 */
export async function uploadApkStream(
  target: AppTarget,
  reqStream: Readable,
  versionOverride?: string
): Promise<AppReleaseInfo> {
  const current = releasesState[target];
  if (!current) {
    throw new Error(`Invalid app release target: ${target}`);
  }

  const fileName = current.fileName; // e.g. "sugo-customer-app.apk" or "sugo-rider-app.apk"
  const targetDirs = getDownloadDirectories();

  // Create primary target directory if it doesn't exist
  const primaryDir = targetDirs[0];
  if (!existsSync(primaryDir)) {
    mkdirSync(primaryDir, { recursive: true });
  }

  const tempFilePath = path.join(primaryDir, `${fileName}.${Date.now()}.tmp`);
  const finalFilePath = path.join(primaryDir, fileName);

  let byteCount = 0;
  let headerBuffer: Buffer = Buffer.alloc(0);
  const hash = crypto.createHash("sha256");

  const countingTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.length;
      if (headerBuffer.length < 4) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]).subarray(0, 4);
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const writeStream = createWriteStream(tempFilePath);

  try {
    await pipeline(reqStream, countingTransform, writeStream);
  } catch (streamErr) {
    // Clean up temporary file on abort/failure
    try {
      await fs.unlink(tempFilePath);
    } catch {}
    throw new Error(`Failed to stream APK upload: ${(streamErr as Error).message}`);
  }

  // Verify APK signature (Android APK is a standard ZIP archive starting with PK\x03\x04 or PK\x05\x06)
  if (headerBuffer.length < 2 || headerBuffer[0] !== 0x50 || headerBuffer[1] !== 0x4b) {
    try {
      await fs.unlink(tempFilePath);
    } catch {}
    throw new Error("Uploaded file is not a valid Android APK archive (missing ZIP magic header 'PK').");
  }

  // Atomically rename temp file to final filename in primary directory
  await fs.rename(tempFilePath, finalFilePath);

  // If there are secondary directories (e.g. server/public/downloads or local landing page), copy as well
  for (let i = 1; i < targetDirs.length; i++) {
    const secondaryDir = targetDirs[i];
    try {
      if (!existsSync(secondaryDir)) {
        mkdirSync(secondaryDir, { recursive: true });
      }
      await fs.copyFile(finalFilePath, path.join(secondaryDir, fileName));
    } catch (copyErr) {
      logger.warn(`[AppReleaseService] Could not copy APK to secondary location (${secondaryDir}):`, copyErr);
    }
  }

  const sha256Hex = hash.digest("hex");
  const formattedSize = `${(byteCount / (1024 * 1024)).toFixed(0)} MB`;

  current.fileSizeBytes = byteCount;
  current.fileSize = formattedSize;
  current.sha256 = sha256Hex;
  current.updatedAt = new Date().toISOString();

  if (versionOverride && versionOverride.trim()) {
    current.version = versionOverride.trim();
  }

  releasesState[target] = current;
  await saveAppReleases();

  try {
    eventPublisher.emit("system:app_releases_update", releasesState);
  } catch (emitErr) {
    logger.warn("[AppReleaseService] Failed to emit Socket.IO release update:", emitErr);
  }

  logger.info(
    `[AppReleaseService] Successfully deployed ${current.appName} APK (${formattedSize}, ${sha256Hex.slice(0, 8)}...)`
  );

  return current;
}

/**
 * Chunk upload result contract.
 */
export interface ChunkSaveResult {
  success: boolean;
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  bytesReceived: number;
}

/**
 * Save an individual chunk to the staging directory for the specified uploadId.
 */
export async function saveChunk(
  target: AppTarget,
  uploadId: string,
  chunkIndex: number,
  totalChunks: number,
  chunkStream: Readable
): Promise<ChunkSaveResult> {
  const current = releasesState[target];
  if (!current) {
    throw new Error(`Invalid app release target: ${target}`);
  }

  // Prevent path traversal on uploadId
  if (!uploadId || !/^[a-zA-Z0-9_\-]+$/.test(uploadId)) {
    throw new Error("Invalid or missing uploadId");
  }

  if (isNaN(chunkIndex) || chunkIndex < 0 || isNaN(totalChunks) || totalChunks <= 0 || chunkIndex >= totalChunks) {
    throw new Error(`Invalid chunk index ${chunkIndex} of ${totalChunks}`);
  }

  const uploadDir = path.join(CHUNKS_BASE_DIR, uploadId);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const chunkFilePath = path.join(uploadDir, `part_${chunkIndex}.tmp`);
  const writeStream = createWriteStream(chunkFilePath);

  let bytesReceived = 0;
  const countingTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesReceived += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(chunkStream, countingTransform, writeStream);
  } catch (err) {
    try {
      await fs.unlink(chunkFilePath);
    } catch {}
    throw new Error(`Failed to save chunk ${chunkIndex}: ${(err as Error).message}`);
  }

  return {
    success: true,
    uploadId,
    chunkIndex,
    totalChunks,
    bytesReceived,
  };
}

/**
 * Concatenate all chunk parts in order, verify ZIP header, compute SHA256,
 * atomically deploy to downloads directory, clean up staging, and update release state.
 */
export async function finalizeChunkedUpload(
  target: AppTarget,
  uploadId: string,
  totalChunks: number,
  versionOverride?: string
): Promise<AppReleaseInfo> {
  const current = releasesState[target];
  if (!current) {
    throw new Error(`Invalid app release target: ${target}`);
  }

  if (!uploadId || !/^[a-zA-Z0-9_\-]+$/.test(uploadId)) {
    throw new Error("Invalid uploadId");
  }

  if (isNaN(totalChunks) || totalChunks <= 0) {
    throw new Error("Invalid totalChunks count");
  }

  const uploadDir = path.join(CHUNKS_BASE_DIR, uploadId);
  if (!existsSync(uploadDir)) {
    throw new Error("Chunk staging directory not found or expired. Please restart upload.");
  }

  // Verify all parts exist before assembling
  for (let i = 0; i < totalChunks; i++) {
    const partPath = path.join(uploadDir, `part_${i}.tmp`);
    if (!existsSync(partPath)) {
      throw new Error(`Missing chunk part ${i} of ${totalChunks}. Upload is incomplete.`);
    }
  }

  const fileName = current.fileName; // "sugo-customer-app.apk" or "sugo-rider-app.apk"
  const targetDirs = getDownloadDirectories();
  const primaryDir = targetDirs[0];
  if (!existsSync(primaryDir)) {
    mkdirSync(primaryDir, { recursive: true });
  }

  const tempFilePath = path.join(primaryDir, `${fileName}.${Date.now()}.tmp`);
  const finalFilePath = path.join(primaryDir, fileName);

  const writeStream = createWriteStream(tempFilePath);
  let byteCount = 0;
  let headerBuffer: Buffer = Buffer.alloc(0);
  const hash = crypto.createHash("sha256");

  try {
    for (let i = 0; i < totalChunks; i++) {
      const partPath = path.join(uploadDir, `part_${i}.tmp`);
      await new Promise<void>((resolve, reject) => {
        const readStream = createReadStream(partPath);
        readStream.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteCount += buf.length;
          if (headerBuffer.length < 4) {
            headerBuffer = Buffer.concat([headerBuffer, buf]).subarray(0, 4);
          }
          hash.update(buf);
          if (!writeStream.write(buf)) {
            readStream.pause();
            writeStream.once("drain", () => readStream.resume());
          }
        });
        readStream.on("end", () => resolve());
        readStream.on("error", (err) => reject(err));
      });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on("error", (err) => reject(err));
    });
  } catch (assembleErr) {
    try {
      await fs.unlink(tempFilePath);
    } catch {}
    throw new Error(`Failed to assemble chunks: ${(assembleErr as Error).message}`);
  }

  // Verify APK signature (Android APK is a standard ZIP archive starting with PK\x03\x04 or PK\x05\x06)
  if (headerBuffer.length < 2 || headerBuffer[0] !== 0x50 || headerBuffer[1] !== 0x4b) {
    try {
      await fs.unlink(tempFilePath);
    } catch {}
    await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("Assembled file is not a valid Android APK archive (missing ZIP magic header 'PK').");
  }

  // Atomically rename temp file to final filename in primary directory
  await fs.rename(tempFilePath, finalFilePath);

  // If there are secondary directories (e.g. server/public/downloads or local landing page), copy as well
  for (let i = 1; i < targetDirs.length; i++) {
    const secondaryDir = targetDirs[i];
    try {
      if (!existsSync(secondaryDir)) {
        mkdirSync(secondaryDir, { recursive: true });
      }
      await fs.copyFile(finalFilePath, path.join(secondaryDir, fileName));
    } catch (copyErr) {
      logger.warn(`[AppReleaseService] Could not copy APK to secondary location (${secondaryDir}):`, copyErr);
    }
  }

  // Clean up the staging chunks directory on successful assembly
  await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});

  const sha256Hex = hash.digest("hex");
  const formattedSize = `${(byteCount / (1024 * 1024)).toFixed(0)} MB`;

  current.fileSizeBytes = byteCount;
  current.fileSize = formattedSize;
  current.sha256 = sha256Hex;
  current.updatedAt = new Date().toISOString();

  if (versionOverride && versionOverride.trim()) {
    current.version = versionOverride.trim();
  }

  releasesState[target] = current;
  await saveAppReleases();

  try {
    eventPublisher.emit("system:app_releases_update", releasesState);
  } catch (emitErr) {
    logger.warn("[AppReleaseService] Failed to emit Socket.IO release update:", emitErr);
  }

  logger.info(
    `[AppReleaseService] Successfully assembled chunked APK for ${current.appName} (${formattedSize}, ${sha256Hex.slice(0, 8)}..., ${totalChunks} chunks)`
  );

  return current;
}

/**
 * Remove any staged chunks if the client cancelled the upload.
 */
export async function cancelChunkedUpload(uploadId: string): Promise<void> {
  if (!uploadId || !/^[a-zA-Z0-9_\-]+$/.test(uploadId)) return;
  const uploadDir = path.join(CHUNKS_BASE_DIR, uploadId);
  try {
    if (existsSync(uploadDir)) {
      await fs.rm(uploadDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn(`[AppReleaseService] Error cancelling chunked upload (${uploadId}):`, err);
  }
}

/**
 * Locate existing APK file and metadata for download.
 */
export function getApkFileInfo(target: AppTarget): {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  appName: string;
} {
  const current = releasesState[target];
  if (!current) {
    throw new Error(`Invalid app release target: ${target}`);
  }

  const targetDirs = getDownloadDirectories();
  let existingFilePath: string | null = null;

  for (const dir of targetDirs) {
    const candidate = path.join(dir, current.fileName);
    if (existsSync(candidate)) {
      existingFilePath = candidate;
      break;
    }
  }

  if (!existingFilePath) {
    throw new Error(`APK file for ${current.appName} not found on server.`);
  }

  // Exact disk file size calculation to guarantee Content-Length matches stream EOF
  const stat = statSync(existingFilePath);
  const actualSize = stat.size;

  if (current.fileSizeBytes !== actualSize) {
    current.fileSizeBytes = actualSize;
    current.fileSize = `${(actualSize / (1024 * 1024)).toFixed(0)} MB`;
  }

  return {
    filePath: existingFilePath,
    fileName: current.fileName,
    fileSizeBytes: actualSize,
    appName: current.appName,
  };
}

export interface ApkStreamResult {
  stream: Readable;
  fileName: string;
  fileSizeBytes: number;
  start: number;
  end: number;
  chunkLength: number;
  isPartial: boolean;
}

/**
 * Returns a readable stream for direct APK downloads, supporting RFC 7233 byte ranges.
 */
export function getApkFileStream(
  target: AppTarget,
  range?: { start: number; end: number }
): ApkStreamResult {
  const fileInfo = getApkFileInfo(target);
  const total = fileInfo.fileSizeBytes;

  if (range) {
    const { start, end } = range;
    if (start < 0 || end >= total || start > end) {
      throw new Error(`Range unsatisifiable: ${start}-${end}/${total}`);
    }
    const chunkLength = end - start + 1;
    const stream = createReadStream(fileInfo.filePath, {
      start,
      end,
      highWaterMark: 64 * 1024,
    });
    return {
      stream,
      fileName: fileInfo.fileName,
      fileSizeBytes: total,
      start,
      end,
      chunkLength,
      isPartial: true,
    };
  }

  const stream = createReadStream(fileInfo.filePath, {
    highWaterMark: 64 * 1024,
  });

  return {
    stream,
    fileName: fileInfo.fileName,
    fileSizeBytes: total,
    start: 0,
    end: total > 0 ? total - 1 : 0,
    chunkLength: total,
    isPartial: false,
  };
}

export interface ApkChunkResult {
  stream: Readable;
  fileName: string;
  fileSizeBytes: number;
  chunkIndex: number;
  totalChunks: number;
  chunkSize: number;
  start: number;
  end: number;
}

/**
 * Returns a readable stream for a specific discrete chunk index (e.g. for segmented downloaders).
 */
export function getApkChunkStream(
  target: AppTarget,
  chunkIndex: number,
  requestedChunkSize: number = 5 * 1024 * 1024
): ApkChunkResult {
  const fileInfo = getApkFileInfo(target);
  const total = fileInfo.fileSizeBytes;

  // Clamp chunk size between 64KB and 20MB
  const chunkSize = Math.max(64 * 1024, Math.min(requestedChunkSize, 20 * 1024 * 1024));
  const totalChunks = Math.max(1, Math.ceil(total / chunkSize));

  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new Error(`Chunk index ${chunkIndex} out of bounds (total chunks: ${totalChunks})`);
  }

  const start = chunkIndex * chunkSize;
  const end = Math.min(start + chunkSize - 1, total - 1);
  const currentChunkBytes = end - start + 1;

  const stream = createReadStream(fileInfo.filePath, {
    start,
    end,
    highWaterMark: 64 * 1024,
  });

  return {
    stream,
    fileName: fileInfo.fileName,
    fileSizeBytes: total,
    chunkIndex,
    totalChunks,
    chunkSize: currentChunkBytes,
    start,
    end,
  };
}

// Initial bootstrap on module load
void loadAppReleases();
void cleanStaleChunks();
