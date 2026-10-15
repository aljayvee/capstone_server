import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import {
  getPublicReleases,
  getSysAdminReleases,
  getApkFileInfo,
  getApkFileStream,
  getApkChunkStream,
  loadAppReleases,
} from "../src/services/appReleaseService.js";

describe("App Release Streaming & Range Download Architecture", () => {
  const dummyCustomerApkPath = path.resolve(process.cwd(), "public", "downloads", "sugo-customer-app.apk");

  beforeAll(async () => {
    // Ensure public/downloads directory and a mock APK exist for testing streams
    await fs.mkdir(path.dirname(dummyCustomerApkPath), { recursive: true });
    // Write 256KB dummy buffer starting with 'PK' (ZIP header)
    const mockApkData = Buffer.alloc(256 * 1024, 0x41);
    mockApkData[0] = 0x50; // 'P'
    mockApkData[1] = 0x4b; // 'K'
    mockApkData[2] = 0x03;
    mockApkData[3] = 0x04;
    await fs.writeFile(dummyCustomerApkPath, mockApkData);

    await loadAppReleases();
  });

  it("should load public and sysadmin releases configuration", () => {
    const publicReleases = getPublicReleases();
    expect(publicReleases).toBeDefined();
    expect(publicReleases.customer).toBeDefined();
    expect(publicReleases.customer.appName).toBe("Sugo Express");
    expect(publicReleases.rider).toBeDefined();
    expect(publicReleases.rider.appName).toBe("Sugo Rider");

    const sysAdminReleases = getSysAdminReleases();
    expect(sysAdminReleases.customer.packageName).toBe("com.sugo.customer");
    expect(sysAdminReleases.rider.packageName).toBe("com.sugo.rider");
  });

  it("should resolve existing APK file info and verify valid path", () => {
    const info = getApkFileInfo("customer");
    expect(info).toBeDefined();
    expect(info.fileName).toBe("sugo-customer-app.apk");
    expect(info.filePath).toBeTruthy();
    expect(info.fileSizeBytes).toBeGreaterThan(0);
  });

  it("should stream full file when range is not specified", async () => {
    const info = getApkFileInfo("customer");
    const result = getApkFileStream("customer");
    expect(result.isPartial).toBe(false);
    expect(result.start).toBe(0);
    expect(result.chunkLength).toBe(result.fileSizeBytes);

    let bytesRead = 0;
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
      });
      result.stream.on("end", () => resolve());
      result.stream.on("error", (err) => reject(err));
    });

    expect(bytesRead).toBe(info.fileSizeBytes);
  });

  it("should support RFC 7233 partial content range streaming", async () => {
    // Request bytes 100 to 199 (100 bytes slice)
    const result = getApkFileStream("customer", { start: 100, end: 199 });
    expect(result.isPartial).toBe(true);
    expect(result.start).toBe(100);
    expect(result.end).toBe(199);
    expect(result.chunkLength).toBe(100);

    let bytesRead = 0;
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
      });
      result.stream.on("end", () => resolve());
      result.stream.on("error", (err) => reject(err));
    });

    expect(bytesRead).toBe(100);
  });

  it("should throw error for out-of-bounds byte range", () => {
    expect(() => {
      getApkFileStream("customer", { start: 999999999, end: 999999999 });
    }).toThrow(/Range unsatisifiable/);

    expect(() => {
      getApkFileStream("customer", { start: 200, end: 100 });
    }).toThrow(/Range unsatisifiable/);
  });

  it("should support discrete chunk retrieval with getApkChunkStream", async () => {
    // 64 KB chunk size on 256 KB file = 4 chunks (0, 1, 2, 3)
    const chunkSize = 64 * 1024;
    const chunk0 = getApkChunkStream("customer", 0, chunkSize);
    expect(chunk0.chunkIndex).toBe(0);
    expect(chunk0.start).toBe(0);
    expect(chunk0.end).toBe(64 * 1024 - 1);
    expect(chunk0.chunkSize).toBe(64 * 1024);

    let bytesRead = 0;
    await new Promise<void>((resolve, reject) => {
      chunk0.stream.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
      });
      chunk0.stream.on("end", () => resolve());
      chunk0.stream.on("error", (err) => reject(err));
    });

    expect(bytesRead).toBe(64 * 1024);
  });

  it("should reject invalid chunk index", () => {
    expect(() => {
      getApkChunkStream("customer", -1, 64 * 1024);
    }).toThrow(/out of bounds/);

    expect(() => {
      getApkChunkStream("customer", 9999, 64 * 1024);
    }).toThrow(/out of bounds/);
  });
});
