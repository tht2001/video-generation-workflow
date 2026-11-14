// Privileged host handlers: local file reads and ffmpeg stitching.
// Action code imports the contract descriptors from "@space/privileged"
// (generated from this file) and calls ctx.executePrivileged(...).
// Handlers run host-side with Node/Bun APIs; requests and responses are
// JSON, so file bytes travel as base64 chunks.
//
// Stitching runs as a DETACHED background process: a single synchronous
// stitch call takes minutes (several full re-encodes), which always blows
// past the ~30s action-invoke limit and gets reported as a failure even
// though nothing is wrong with the footage. `stitchBackground` therefore
// only starts (or polls) the work: it writes a small runner script that
// executes the very same `stitchMain` function, spawns it detached, and
// reports state from marker files the runner leaves behind.

import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type StitchArgs = {
  spaceDir: string;
  jobId: number;
  aspect: string;
  items: { videoBlobKey: string; subtitle: string; durationSec: number }[];
};

type StitchResult = {
  outputPath: string;
  totalDurationSec: number;
  resolution: string;
  shotCount: number;
  mode: string;
};

export const privileged = definePrivilegedContracts({
  readFileChunk: {
    request: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(0),
      length: z.number().int().positive().max(4_000_000),
    }),
    response: z.object({
      dataBase64: z.string(),
      eof: z.boolean(),
      totalSize: z.number(),
    }),
    timeoutMs: 120_000,
  },
  stitchVideos: {
    request: z.object({
      spaceDir: z.string().min(1),
      jobId: z.number().int(),
      aspect: z.string(),
      items: z
        .array(
          z.object({
            videoBlobKey: z.string().min(1),
            subtitle: z.string(),
            durationSec: z.number().positive(),
          }),
        )
        .min(1)
        .max(60),
    }),
    response: z.object({
      outputPath: z.string(),
      totalDurationSec: z.number(),
      resolution: z.string(),
      shotCount: z.number(),
      mode: z.string(),
    }),
    timeoutMs: 1_800_000,
  },
  extractFrames: {
    request: z.object({
      spaceDir: z.string().min(1),
      blobKey: z.string().min(1),
      count: z.number().int().min(1).max(6),
    }),
    response: z.object({
      frames: z.array(z.object({ dataBase64: z.string(), mimeType: z.string() })),
      durationSec: z.number(),
    }),
    timeoutMs: 180_000,
  },
  readBlobImage: {
    request: z.object({
      spaceDir: z.string().min(1),
      blobKey: z.string().min(1),
      maxWidth: z.number().int().min(64).max(1024),
    }),
    response: z.object({
      found: z.boolean(),
      dataBase64: z.string(),
      mimeType: z.string(),
    }),
    timeoutMs: 60_000,
  },
  stitchBackground: {
    request: z.object({
      spaceDir: z.string().min(1),
      jobId: z.number().int(),
      aspect: z.string(),
      items: z
        .array(
          z.object({
            videoBlobKey: z.string().min(1),
            subtitle: z.string(),
            durationSec: z.number().positive(),
          }),
        )
        .min(1)
        .max(60),
    }),
    response: z.object({
      state: z.enum(["started", "running", "done", "failed"]),
      outputPath: z.string().nullable(),
      totalDurationSec: z.number().nullable(),
      resolution: z.string().nullable(),
      shotCount: z.number().nullable(),
      mode: z.string().nullable(),
      error: z.string().nullable(),
    }),
    timeoutMs: 120_000,
  },
});

/**
 * The whole ffmpeg stitch pipeline as ONE self-contained function: it must
 * not reference anything from module scope (only its argument and dynamic
 * node: imports), because stitchBackground serializes it with
 * Function.prototype.toString() into a runner script for a detached child
 * process. The in-process stitchVideos handler calls it directly.
 */
async function stitchMain(args: StitchArgs): Promise<StitchResult> {
  const { createHash } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const execFileAsync = promisify(execFile);

  async function blobFilePath(spaceDir: string, key: string): Promise<string> {
    const id = createHash("sha256").update(key).digest("hex");
    const sharded = path.join(spaceDir, "blobs", "objects", id.slice(0, 2), id);
    try {
      await fs.access(sharded);
      return sharded;
    } catch {
      return path.join(spaceDir, "blobs", "objects", key);
    }
  }

  function assEscape(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
  }

  function buildAss(items: { subtitle: string; durationSec: number }[], width: number, height: number): string {
    const fontSize = Math.round(width * 0.045);
    const header = [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,20,20,${Math.round(height * 0.06)},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    const fmt = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
    };
    const lines: string[] = [];
    let t = 0;
    for (const item of items) {
      const text = item.subtitle.trim();
      if (text) {
        lines.push(`Dialogue: 0,${fmt(t)},${fmt(t + item.durationSec)},Default,,0,0,0,,${assEscape(text)}`);
      }
      t += item.durationSec;
    }
    return [...header, ...lines].join("\n");
  }

  const portrait = args.aspect !== "16:9";
  const width = portrait ? 720 : 1280;
  const height = portrait ? 1280 : 720;
  const workDir = path.join(args.spaceDir, "stitch-work", String(args.jobId));
  await fs.mkdir(workDir, { recursive: true });

  // Resolve each shot's blob file on disk.
  const inputs: string[] = [];
  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!;
    const p = await blobFilePath(args.spaceDir, item.videoBlobKey);
    try {
      await fs.access(p);
    } catch {
      throw new Error(`第 ${i + 1} 镜的视频文件在存储中找不到（blob: ${item.videoBlobKey}），请重新生成该镜后再拼接`);
    }
    inputs.push(p);
  }

  // Normalize every shot to the same size/fps/codec into intermediates.
  // Segments already encoded by an earlier (interrupted) attempt are
  // reused, so a retry does not redo finished work.
  const intermediates: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const out = path.join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    const st = await fs.stat(out).catch(() => null);
    if (!st || st.size === 0) {
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
      await execFileAsync(
        "ffmpeg",
        ["-y", "-i", inputs[i]!, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "44100", "-ac", "2", out],
        { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
      ).catch((e: Error) => {
        throw new Error(`第 ${i + 1} 镜转码失败：${e.message.slice(0, 300)}`);
      });
    }
    intermediates.push(out);
  }

  const totalDuration = args.items.reduce((sum, it) => sum + it.durationSec, 0);
  const useDissolve = args.items.length <= 8 && totalDuration <= 180;
  const joined = path.join(workDir, "joined.mp4");
  let mode: string;

  const joinedStat = await fs.stat(joined).catch(() => null);
  if (joinedStat && joinedStat.size > 0) {
    mode = useDissolve ? "尾帧叠化过渡拼接（短片模式，复用上次拼接结果）" : "拼接（复用上次拼接结果）";
  } else if (useDissolve && intermediates.length > 1) {
    // Freeze the previous shot's last frame briefly and crossfade into
    // the next shot, chaining through all segments.
    const filterParts: string[] = [];
    let current = "[0:v]";
    let offset = 0;
    for (let i = 1; i < intermediates.length; i++) {
      const prevDur = args.items[i - 1]!.durationSec;
      offset += prevDur;
      const label = i === intermediates.length - 1 ? "[vout]" : `[vx${i}]`;
      filterParts.push(`${current}[${i}:v]xfade=transition=fade:duration=0.5:offset=${Math.max(0, offset - 0.5).toFixed(2)}${label}`);
      current = label;
    }
    const audioInputs = intermediates.map((_, i) => `[${i}:a]`).join("");
    const filter = `${filterParts.join(";")};${audioInputs}concat=n=${intermediates.length}:v=0:a=1[aout]`;
    await execFileAsync(
      "ffmpeg",
      ["-y", ...intermediates.flatMap((p) => ["-i", p]), "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", joined],
      { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: Error) => {
      throw new Error(`叠化拼接失败：${e.message.slice(0, 300)}`);
    });
    mode = "尾帧叠化过渡拼接（短片模式）";
  } else if (intermediates.length === 1) {
    await execFileAsync("ffmpeg", ["-y", "-i", intermediates[0]!, "-c", "copy", joined], { timeout: 300_000 });
    mode = "单镜直出";
  } else {
    // Long film: lossless concat of the normalized segments.
    const listPath = path.join(workDir, "list.txt");
    await fs.writeFile(listPath, intermediates.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    await execFileAsync(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", joined],
      { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: Error) => {
      throw new Error(`无损拼接失败：${e.message.slice(0, 300)}`);
    });
    mode = "无损直接拼接（长片模式）";
  }

  // Burn subtitles: white text, black outline, no background box.
  const assPath = path.join(workDir, "subs.ass");
  await fs.writeFile(assPath, buildAss(args.items, width, height), "utf8");
  const outputPath = path.join(args.spaceDir, "stitch-out", `final-${args.jobId}.mp4`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const hasSubs = args.items.some((it) => it.subtitle.trim().length > 0);
  if (hasSubs) {
    const assEscaped = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", joined, "-vf", `ass='${assEscaped}'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", outputPath],
      { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: Error) => {
      throw new Error(`烧录字幕失败：${e.message.slice(0, 300)}`);
    });
  } else {
    await execFileAsync("ffmpeg", ["-y", "-i", joined, "-c", "copy", outputPath], { timeout: 300_000 });
  }

  // Probe the result for authoritative duration / resolution.
  let totalDurationSec = totalDuration;
  let resolution = `${width}x${height}`;
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", outputPath],
      { timeout: 60_000 },
    );
    const parsed = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const stream = parsed.streams?.[0];
    if (stream?.width && stream?.height) resolution = `${stream.width}x${stream.height}`;
    const dur = Number(parsed.format?.duration);
    if (Number.isFinite(dur) && dur > 0) totalDurationSec = Math.round(dur * 10) / 10;
  } catch {
    // Keep the summed duration if probing fails.
  }

  return {
    outputPath,
    totalDurationSec,
    resolution,
    shotCount: args.items.length,
    mode,
  };
}

/** Resolve a blob key to its file on disk (same layout the stitcher uses). */
async function blobFilePath(spaceDir: string, key: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const id = createHash("sha256").update(key).digest("hex");
  const sharded = path.join(spaceDir, "blobs", "objects", id.slice(0, 2), id);
  try {
    await fs.access(sharded);
    return sharded;
  } catch {
    return path.join(spaceDir, "blobs", "objects", key);
  }
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async extractFrames(args) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const execFileAsync = promisify(execFile);
    const src = await blobFilePath(args.spaceDir, args.blobKey);
    try {
      await fs.access(src);
    } catch {
      throw new Error(`要抽帧的视频文件在存储中找不到（blob: ${args.blobKey}）`);
    }
    let durationSec = 0;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "json", src],
        { timeout: 30_000 },
      );
      const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
      durationSec = Number(parsed.format?.duration) || 0;
    } catch {
      durationSec = 0;
    }
    const dir = path.join(args.spaceDir, "qa-work");
    await fs.mkdir(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const frames: { dataBase64: string; mimeType: string }[] = [];
    for (let i = 0; i < args.count; i++) {
      const t = durationSec > 0 ? (durationSec * (i + 1)) / (args.count + 1) : i * 2 + 0.5;
      const out = path.join(dir, `frame-${stamp}-${i}.jpg`);
      try {
        await execFileAsync(
          "ffmpeg",
          ["-y", "-ss", t.toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", out],
          { timeout: 60_000 },
        );
        const buf = await fs.readFile(out);
        if (buf.length > 0) frames.push({ dataBase64: buf.toString("base64"), mimeType: "image/jpeg" });
      } catch {
        // A single failed frame is skipped; zero frames is the caller's error.
      }
      await fs.unlink(out).catch(() => undefined);
    }
    return { frames, durationSec };
  },

  async readBlobImage(args) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const execFileAsync = promisify(execFile);
    const empty = { found: false, dataBase64: "", mimeType: "image/jpeg" };
    const src = await blobFilePath(args.spaceDir, args.blobKey);
    try {
      await fs.access(src);
    } catch {
      return empty;
    }
    const dir = path.join(args.spaceDir, "qa-work");
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `anchor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.jpg`);
    try {
      await execFileAsync(
        "ffmpeg",
        ["-y", "-i", src, "-frames:v", "1", "-vf", `scale=${args.maxWidth}:-2`, "-q:v", "5", out],
        { timeout: 60_000 },
      );
      const buf = await fs.readFile(out);
      if (buf.length === 0) return empty;
      return { found: true, dataBase64: buf.toString("base64"), mimeType: "image/jpeg" };
    } catch {
      return empty;
    } finally {
      await fs.unlink(out).catch(() => undefined);
    }
  },

  async readFileChunk(args) {
    const st = await stat(args.path);
    const totalSize = st.size;
    if (args.offset >= totalSize) {
      return { dataBase64: "", eof: true, totalSize };
    }
    const buf = Buffer.alloc(Math.min(args.length, totalSize - args.offset));
    const { open } = await import("node:fs/promises");
    const fh = await open(args.path, "r");
    try {
      const { bytesRead } = await fh.read(buf, 0, buf.length, args.offset);
      const slice = buf.subarray(0, bytesRead);
      return {
        dataBase64: slice.toString("base64"),
        eof: args.offset + bytesRead >= totalSize,
        totalSize,
      };
    } finally {
      await fh.close();
    }
  },

  async stitchVideos(args) {
    return stitchMain(args);
  },

  async stitchBackground(args) {
    const workDir = join(args.spaceDir, "stitch-work", String(args.jobId));
    const resultPath = join(workDir, "result.json");
    const errorPath = join(workDir, "error.txt");
    const scriptPath = join(workDir, "run.mjs");
    const empty = {
      outputPath: null,
      totalDurationSec: null,
      resolution: null,
      shotCount: null,
      mode: null,
      error: null,
    };

    const resultText = await readFile(resultPath, "utf8").catch(() => null);
    if (resultText) {
      try {
        const r = JSON.parse(resultText) as StitchResult;
        return {
          state: "done" as const,
          outputPath: r.outputPath,
          totalDurationSec: r.totalDurationSec,
          resolution: r.resolution,
          shotCount: r.shotCount,
          mode: r.mode,
          error: null,
        };
      } catch {
        return { state: "failed" as const, ...empty, error: "拼接结果文件损坏，请重试拼接。" };
      }
    }
    const errorText = await readFile(errorPath, "utf8").catch(() => null);
    if (errorText) {
      return { state: "failed" as const, ...empty, error: errorText.slice(0, 500) };
    }
    const scriptStat = await stat(scriptPath).catch(() => null);
    if (scriptStat) {
      return { state: "running" as const, ...empty };
    }

    // Not started yet: write a runner that executes the same stitchMain
    // and leaves result/error markers, then spawn it detached so this
    // call returns immediately instead of running ffmpeg inline.
    const script = [
      `const stitchMain = ${stitchMain.toString()};`,
      `const { writeFile } = await import("node:fs/promises");`,
      `const args = ${JSON.stringify(args)};`,
      `try {`,
      `  const r = await stitchMain(args);`,
      `  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(r), "utf8");`,
      `} catch (e) {`,
      `  await writeFile(${JSON.stringify(errorPath)}, String(e && e.message ? e.message : e), "utf8");`,
      `}`,
      ``,
    ].join("\n");
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(workDir, { recursive: true });
      await writeFile(scriptPath, script, "utf8");
      const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: "ignore" });
      child.unref();
      return { state: "started" as const, ...empty };
    } catch (e) {
      // Detached spawn unavailable: fall back to running inline so the
      // stitch still happens (slow, but only as a last resort).
      try {
        const r = await stitchMain(args);
        return {
          state: "done" as const,
          outputPath: r.outputPath,
          totalDurationSec: r.totalDurationSec,
          resolution: r.resolution,
          shotCount: r.shotCount,
          mode: r.mode,
          error: null,
        };
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        const spawnMsg = e instanceof Error ? e.message : String(e);
        return { state: "failed" as const, ...empty, error: `${msg}（后台启动失败：${spawnMsg}）`.slice(0, 500) };
      }
    }
  },
});
