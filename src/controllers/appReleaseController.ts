import { Request, Response } from "express";
import {
  AppTarget,
  getPublicReleases,
  getSysAdminReleases,
  updateReleaseDetails,
  uploadApkStream,
  saveChunk,
  finalizeChunkedUpload,
  cancelChunkedUpload,
  getApkFileStream,
  getApkFileInfo,
  getApkChunkStream,
} from "../services/appReleaseService.js";
import { logger } from "../lib/logger.js";

/**
 * Public endpoint consumed by sugoonthego.online landing page and mobile apps.
 */
export async function getPublicReleasesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const releases = getPublicReleases();
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    res.json({
      success: true,
      releases,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[AppReleaseController] Error fetching public releases:", err);
    res.status(500).json({ success: false, message: "Failed to retrieve app releases" });
  }
}

/**
 * Authenticated SysAdmin endpoint to inspect app release inventory.
 */
export async function getSysAdminReleasesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const releases = getSysAdminReleases();
    res.json({
      success: true,
      releases,
    });
  } catch (err) {
    logger.error("[AppReleaseController] Error fetching sysadmin releases:", err);
    res.status(500).json({ success: false, message: "Failed to load app releases" });
  }
}

/**
 * Authenticated SysAdmin endpoint to update release metadata (version, minAndroid, whatsNew).
 */
export async function updateReleaseDetailsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const { version, minAndroid, fileSize, whatsNew, features, fixes, logs } = req.body;
    const updated = await updateReleaseDetails(target as AppTarget, {
      version,
      minAndroid,
      fileSize,
      whatsNew,
      features,
      fixes,
      logs,
    });

    res.json({
      success: true,
      message: `Successfully updated ${updated.appName} release details`,
      release: updated,
    });
  } catch (err: any) {
    logger.error("[AppReleaseController] Error updating release details:", err);
    res.status(400).json({ success: false, message: err.message || "Failed to update release details" });
  }
}

/**
 * Authenticated SysAdmin endpoint for streaming APK binary upload.
 * Uses raw request streaming directly to disk (Content-Type: application/octet-stream or multipart).
 */
export async function uploadApkHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const versionOverride = (req.query.version as string) || undefined;

    logger.info(`[AppReleaseController] Initiating streaming APK upload for target: ${target}`);

    const updatedRelease = await uploadApkStream(target as AppTarget, req, versionOverride);

    res.json({
      success: true,
      message: `Successfully uploaded and deployed ${updatedRelease.appName} APK (${updatedRelease.fileSize})`,
      release: updatedRelease,
    });
  } catch (err: any) {
    logger.error("[AppReleaseController] Error streaming APK upload:", err);
    res.status(400).json({
      success: false,
      message: err.message || "Failed to upload APK file",
    });
  }
}

/**
 * Streaming APK download endpoint with RFC 7233 HTTP 206 Partial Content support.
 * Allows mobile devices and download managers to stream chunk-by-chunk, pause, and resume.
 */
export async function downloadApkHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const fileInfo = getApkFileInfo(target as AppTarget);
    const rangeHeader = req.headers.range;

    // Default response headers
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${fileInfo.fileName}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${fileInfo.fileSizeBytes}`).json({
          success: false,
          message: "Requested range not satisfiable",
        });
        return;
      }

      let start = match[1] ? parseInt(match[1], 10) : NaN;
      let end = match[2] ? parseInt(match[2], 10) : NaN;

      if (isNaN(start) && isNaN(end)) {
        res.status(416).setHeader("Content-Range", `bytes */${fileInfo.fileSizeBytes}`).json({
          success: false,
          message: "Requested range not satisfiable",
        });
        return;
      }

      if (isNaN(start)) {
        // Suffix range: bytes=-500 -> last 500 bytes
        start = Math.max(0, fileInfo.fileSizeBytes - end);
        end = fileInfo.fileSizeBytes - 1;
      } else if (isNaN(end)) {
        // Prefix range: bytes=500- -> from 500 to EOF
        end = fileInfo.fileSizeBytes - 1;
      }

      if (start >= fileInfo.fileSizeBytes || end >= fileInfo.fileSizeBytes || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${fileInfo.fileSizeBytes}`).json({
          success: false,
          message: "Requested range not satisfiable",
        });
        return;
      }

      const streamResult = getApkFileStream(target as AppTarget, { start, end });

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileInfo.fileSizeBytes}`);
      res.setHeader("Content-Length", streamResult.chunkLength.toString());

      req.on("close", () => {
        if (!streamResult.stream.destroyed) {
          streamResult.stream.destroy();
        }
      });

      streamResult.stream.on("error", (err) => {
        logger.warn("[AppReleaseController] Partial download stream error:", err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });

      streamResult.stream.pipe(res);
      return;
    }

    // Full file streaming (chunk-by-chunk over network socket)
    const streamResult = getApkFileStream(target as AppTarget);
    res.status(200);
    if (fileInfo.fileSizeBytes > 0) {
      res.setHeader("Content-Length", fileInfo.fileSizeBytes.toString());
    }

    req.on("close", () => {
      if (!streamResult.stream.destroyed) {
        streamResult.stream.destroy();
      }
    });

    streamResult.stream.on("error", (err) => {
      logger.warn("[AppReleaseController] Full download stream error:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    streamResult.stream.pipe(res);
  } catch (err: any) {
    logger.error("[AppReleaseController] Error streaming download:", err);
    res.status(404).json({ success: false, message: err.message || "APK not found" });
  }
}

/**
 * Programmatic discrete chunk download endpoint.
 * GET /api/app-releases/download-chunk/:target?chunkIndex=0&chunkSize=5242880
 */
export async function downloadApkChunkHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const chunkIndex = parseInt(
      (req.query.chunkIndex as string) || (req.headers["x-chunk-index"] as string) || "0",
      10
    );
    const chunkSize = parseInt(
      (req.query.chunkSize as string) || (req.headers["x-chunk-size"] as string) || "5242880",
      10
    );

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ success: false, message: "Invalid chunkIndex parameter" });
      return;
    }

    const chunkResult = getApkChunkStream(target as AppTarget, chunkIndex, chunkSize);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${chunkResult.fileName}.part${chunkResult.chunkIndex}"`
    );
    res.setHeader(
      "Content-Range",
      `bytes ${chunkResult.start}-${chunkResult.end}/${chunkResult.fileSizeBytes}`
    );
    res.setHeader("Content-Length", chunkResult.chunkSize.toString());
    res.setHeader("X-Chunk-Index", chunkResult.chunkIndex.toString());
    res.setHeader("X-Total-Chunks", chunkResult.totalChunks.toString());
    res.setHeader("X-Chunk-Size", chunkResult.chunkSize.toString());
    res.setHeader("X-Total-Size", chunkResult.fileSizeBytes.toString());
    res.setHeader("Cache-Control", "public, max-age=3600");

    req.on("close", () => {
      if (!chunkResult.stream.destroyed) {
        chunkResult.stream.destroy();
      }
    });

    chunkResult.stream.on("error", (err) => {
      logger.warn("[AppReleaseController] Chunk download stream error:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    chunkResult.stream.pipe(res);
  } catch (err: any) {
    logger.error("[AppReleaseController] Error downloading chunk:", err);
    res.status(404).json({ success: false, message: err.message || "Chunk not available" });
  }
}

/**
 * SysAdmin endpoint for uploading individual 5MB APK chunks.
 */
export async function uploadChunkHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const uploadId = (req.headers["x-upload-id"] as string) || (req.query.uploadId as string);
    const chunkIndex = parseInt(
      (req.headers["x-chunk-index"] as string) || (req.query.chunkIndex as string),
      10
    );
    const totalChunks = parseInt(
      (req.headers["x-total-chunks"] as string) || (req.query.totalChunks as string),
      10
    );

    if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      res.status(400).json({
        success: false,
        message: "Missing required headers or params: X-Upload-Id, X-Chunk-Index, X-Total-Chunks",
      });
      return;
    }

    const result = await saveChunk(
      target as AppTarget,
      uploadId,
      chunkIndex,
      totalChunks,
      req
    );

    res.json({
      ...result,
      message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
    });
  } catch (err: any) {
    logger.error("[AppReleaseController] Error saving chunk:", err);
    res.status(400).json({
      success: false,
      message: err.message || "Failed to process chunk upload",
    });
  }
}

/**
 * SysAdmin endpoint for assembling staged chunks into the final APK.
 */
export async function finalizeChunkedUploadHandler(req: Request, res: Response): Promise<void> {
  try {
    const { target } = req.params;
    if (target !== "customer" && target !== "rider") {
      res.status(400).json({ success: false, message: "Target must be 'customer' or 'rider'" });
      return;
    }

    const { uploadId, totalChunks, version } = req.body;
    const parsedTotal = parseInt(totalChunks, 10);

    if (!uploadId || isNaN(parsedTotal) || parsedTotal <= 0) {
      res.status(400).json({
        success: false,
        message: "Missing or invalid uploadId or totalChunks in request body",
      });
      return;
    }

    logger.info(
      `[AppReleaseController] Assembling ${parsedTotal} chunks for ${target} (uploadId: ${uploadId})...`
    );

    const updatedRelease = await finalizeChunkedUpload(
      target as AppTarget,
      uploadId,
      parsedTotal,
      version
    );

    res.json({
      success: true,
      message: `Successfully assembled and deployed ${updatedRelease.appName} APK (${updatedRelease.fileSize})`,
      release: updatedRelease,
    });
  } catch (err: any) {
    logger.error("[AppReleaseController] Error finalizing chunked upload:", err);
    res.status(400).json({
      success: false,
      message: err.message || "Failed to finalize chunked upload",
    });
  }
}

/**
 * SysAdmin endpoint to abort/cancel an in-progress chunked upload.
 */
export async function cancelChunkedUploadHandler(req: Request, res: Response): Promise<void> {
  try {
    const uploadId = (req.params.uploadId as string) || (req.body?.uploadId as string);
    if (uploadId) {
      await cancelChunkedUpload(uploadId);
    }
    res.json({ success: true, message: "Upload session cancelled and cleaned up" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to cancel upload" });
  }
}
