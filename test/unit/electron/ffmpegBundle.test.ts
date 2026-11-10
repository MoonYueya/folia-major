import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  FFMPEG_ASSETS,
  FFMPEG_RELEASE_TAG,
  archiveExtractionPlan,
  resolveFfmpegAsset,
} from "../../../packaging/ffmpeg/fetch-ffmpeg.mjs";

// Locks the release/target mapping without performing network access in unit tests.

describe("bundled Folia FFmpeg manifest", () => {
  it("pins the Folia FFmpeg release that reads DSDIFF and whose macOS binaries load only system libraries", () => {
    expect(FFMPEG_RELEASE_TAG).toBe("v8.1.2-folia.5");
    for (const asset of Object.values(FFMPEG_ASSETS)) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each([
    ["win32", "x64", "win-x64", "ffmpeg.exe"],
    ["linux", "x64", "linux-x64", "ffmpeg"],
    ["linux", "arm64", "linux-arm64", "ffmpeg"],
    ["darwin", "x64", "mac-x64", "ffmpeg"],
    ["darwin", "arm64", "mac-arm64", "ffmpeg"],
  ])("maps %s/%s to %s", (platform, arch, key, binaryName) => {
    expect(resolveFfmpegAsset(platform, arch)).toMatchObject({
      key,
      binaryName,
    });
  });

  it("fails instead of silently bundling a binary for the wrong architecture", () => {
    expect(() => resolveFfmpegAsset("win32", "arm64")).toThrow(
      "No bundled Folia FFmpeg release",
    );
  });
});

// GNU tar reads a drive letter as a remote host and a backslash as an escape, so neither the
// archive argument nor the -C target may keep the Windows spelling when the runner resolves
// tar through Git Bash.
describe("bundled Folia FFmpeg archive extraction", () => {
  const archiveDir =
    path.sep === "\\"
      ? "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\folia-ffmpeg-abc123"
      : "/tmp/folia-ffmpeg-abc123";
  const nativeArchive = path.join(
    archiveDir,
    "ffmpeg-8.1.2-folia-x86_64-w64-mingw32.tar.gz",
  );
  const nativeDestination = path.join(
    path.sep === "\\" ? "D:\\a\\folia-major\\folia-major" : "/home/runner/work",
    "build",
    "ffmpeg",
    "win-x64",
  );

  it("hands tar a bare archive name from the directory that holds it", () => {
    const plan = archiveExtractionPlan(nativeArchive, nativeDestination);

    expect(plan.cwd).toBe(path.dirname(nativeArchive));
    expect(plan.args).toEqual([
      "-xzf",
      "ffmpeg-8.1.2-folia-x86_64-w64-mingw32.tar.gz",
      "-C",
      nativeDestination.split(path.sep).join("/"),
    ]);
  });

  it("keeps every tar argument free of a drive letter and a backslash", () => {
    const plan = archiveExtractionPlan(nativeArchive, nativeDestination);

    expect(plan.args[1]).not.toContain(":");
    expect(plan.args[1]).not.toContain("/");
    expect(plan.args[1]).not.toContain("\\");
    expect(plan.args[3]).not.toContain("\\");
  });

  it("would have reproduced the CI failure with the arguments it replaces", () => {
    expect(nativeArchive).toContain(path.sep);
    expect(nativeDestination).toContain(path.sep);

    const plan = archiveExtractionPlan(nativeArchive, nativeDestination);
    expect(plan.args[1]).not.toBe(nativeArchive);
    expect(plan.args[3]).not.toBe(nativeDestination);
  });
});
