// Actions for the video-generation workflow space.
//
// Architecture notes:
// - Every long operation is a row in `jobs`. Text and image jobs are
//   advanced step by step by the `advanceJob` action (the client polls it
//   every ~4s while a job is active), so no single request ever runs long
//   enough to hit a gateway timeout, and every step saves before the next
//   begins (breakpoint resume: a retry only redoes the unfinished steps).
// - Video generation and final stitching need agent-only / host tools, so
//   those jobs are executed by a spawned Muse task (ctx.agent.spawnTask)
//   that reports back through `jobStep` / `saveShotVideo`, or by the
//   privileged ffmpeg handler (see privileged.ts).
// - Step 4 has a consistency HARD GATE: a saved shot video is not "ready"
//   until frames sampled from it pass a vision check against every bound
//   character's look anchor (background people included). Failed checks
//   regenerate the shot automatically (bounded by qa_attempts); the
//   stitch refuses any shot that has not passed — no manual exemption.
// - Text work goes through `textComplete`, which routes to Muse
//   (ctx.inference) or to the user's own OpenAI-compatible model when the
//   settings select it. Images and video always use Muse.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

function db(ctx: Ctx) {
  return ctx.db<typeof schema>();
}

function now() {
  return new Date();
}

async function getSettingsRow(ctx: Ctx) {
  const d = db(ctx);
  const rows = await d.select().from(schema.settings).where(eq(schema.settings.id, 1));
  if (rows[0]) return rows[0];
  await d.insert(schema.settings).values({ id: 1 });
  const again = await d.select().from(schema.settings).where(eq(schema.settings.id, 1));
  return again[0]!;
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "••••";
  return `••••••${key.slice(-4)}`;
}

async function modelLabel(ctx: Ctx): Promise<string> {
  const s = await getSettingsRow(ctx);
  if (s.textSource === "custom" && s.customBaseUrl && s.customApiKey && s.customModel) {
    return `自定义模型 ${s.customModel}`;
  }
  return "Muse";
}

function classifyCustomError(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 200);
  if (status === 401 || status === 403) return `自定义模型鉴权失败（HTTP ${status}），请检查 API Key。${snippet}`;
  if (status === 404) return `自定义模型接口或模型不存在（HTTP 404），请检查接口地址与模型名称。${snippet}`;
  if (status === 429) return `自定义模型触发限流（HTTP 429），请稍后再试。${snippet}`;
  return `自定义模型调用失败（HTTP ${status}）。${snippet}`;
}

async function customComplete<T extends z.ZodType>(
  s: { customBaseUrl: string; customApiKey: string; customModel: string },
  prompt: string,
  out: T,
  system?: string,
): Promise<z.infer<T>> {
  const base = s.customBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.customApiKey}`,
      },
      body: JSON.stringify({
        model: s.customModel,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          {
            role: "user",
            content: `${prompt}\n\n只输出一个 JSON 对象作为回答，不要输出任何解释、 markdown 代码块标记或其他文字。`,
          },
        ],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out") || msg.includes("TimeoutError") || msg.includes("abort")) {
      throw new Error("自定义模型连接超时（120 秒未响应），请检查接口地址或稍后重试。");
    }
    throw new Error(`连接自定义模型失败：${msg.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(classifyCustomError(res.status, await res.text().catch(() => "")));
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("自定义模型返回了空内容，请检查模型名称是否正确。");
  const cleaned = content.replace(/```(?:json)?/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`自定义模型返回的内容不是有效 JSON：${cleaned.slice(0, 200)}`);
  }
  return out.parse(parsed);
}

/** Route a bounded text task to Muse or the user's custom model. */
async function textComplete<T extends z.ZodType>(
  ctx: Ctx,
  prompt: string,
  out: T,
  system?: string,
): Promise<z.infer<T>> {
  const s = await getSettingsRow(ctx);
  if (s.textSource === "custom") {
    if (!s.customBaseUrl || !s.customApiKey || !s.customModel) {
      throw new Error("已选择自定义文本模型，但接口地址 / API Key / 模型名称尚未填完整。请到设置里补全，或切回 Muse。");
    }
    return customComplete(s, prompt, out, system);
  }
  return ctx.inference.complete(prompt, { schema: out, system, timeout_secs: 120 });
}

// ------------------------------------------------------------- job engine

type JobPatch = Partial<{
  status: string;
  progressDone: number;
  progressTotal: number;
  message: string;
  detail: Record<string, unknown>;
  error: string | null;
  taskId: string | null;
}>;

async function createJob(
  ctx: Ctx,
  projectId: number | null,
  kind: string,
  detail: Record<string, unknown>,
  message: string,
  progressTotal = 0,
): Promise<number> {
  const d = db(ctx);
  const rows = await d
    .insert(schema.jobs)
    .values({ projectId, kind, status: "running", detail: JSON.stringify(detail), message, progressTotal })
    .returning({ id: schema.jobs.id });
  return rows[0]!.id;
}

async function patchJob(ctx: Ctx, jobId: number, patch: JobPatch) {
  const d = db(ctx);
  const values: Record<string, unknown> = { updatedAt: now() };
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.progressDone !== undefined) values.progressDone = patch.progressDone;
  if (patch.progressTotal !== undefined) values.progressTotal = patch.progressTotal;
  if (patch.message !== undefined) values.message = patch.message;
  if (patch.detail !== undefined) values.detail = JSON.stringify(patch.detail);
  if (patch.error !== undefined) values.error = patch.error;
  if (patch.taskId !== undefined) values.taskId = patch.taskId;
  await d.update(schema.jobs).set(values).where(eq(schema.jobs.id, jobId));
}

async function loadJob(ctx: Ctx, jobId: number) {
  const d = db(ctx);
  const rows = await d.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return rows[0] ?? null;
}

function jobDetail(job: { detail: string }): Record<string, unknown> {
  try {
    return JSON.parse(job.detail) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function findActiveJob(ctx: Ctx, projectId: number, kind: string) {
  const d = db(ctx);
  const rows = await d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.kind, kind), eq(schema.jobs.status, "running")))
    .orderBy(desc(schema.jobs.id));
  return rows[0] ?? null;
}

/** Is a single-shot job (video generation or hard-gate verification)
 *  already running for this shot? Used by batch/stitch drivers so they
 *  never stack duplicate gate checks on the same shot. */
async function hasActiveShotJob(ctx: Ctx, projectId: number, shotId: number): Promise<boolean> {
  const d = db(ctx);
  const rows = await d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.status, "running")));
  return rows.some(
    (j) => (j.kind === "gen_video" || j.kind === "verify_shot") && jobDetail(j).shotId === shotId,
  );
}

// ------------------------------------------------------------ data access

async function loadProject(ctx: Ctx, projectId: number) {
  const d = db(ctx);
  const rows = await d.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  return rows[0] ?? null;
}

async function loadShots(ctx: Ctx, projectId: number) {
  const d = db(ctx);
  return d.select().from(schema.shots).where(eq(schema.shots.projectId, projectId)).orderBy(asc(schema.shots.seq));
}

async function loadCharacters(ctx: Ctx, projectId: number) {
  const d = db(ctx);
  return d.select().from(schema.characters).where(eq(schema.characters.projectId, projectId)).orderBy(asc(schema.characters.id));
}

async function touchProject(ctx: Ctx, projectId: number, extra: Record<string, unknown> = {}) {
  const d = db(ctx);
  await d.update(schema.projects).set({ updatedAt: now(), ...extra }).where(eq(schema.projects.id, projectId));
}

/** Strip a trailing parenthesized grouping suffix: 小猴子们（含小猴子甲） -> 小猴子们 */
function baseName(name: string): string {
  const idx = name.indexOf("（");
  return (idx > 0 ? name.slice(0, idx) : name).trim();
}

function characterComplete(c: { appearance: string; costume: string; personality: string; voice: string }): boolean {
  return Boolean(c.appearance.trim() && c.costume.trim() && c.personality.trim() && c.voice.trim());
}

/**
 * Auto-bind characters to a shot by name matching over its text fields.
 * Names the model reported but that have no character yet create a pending
 * character (unless it is a parenthesized sub-group of an existing one).
 * Returns the bound character ids.
 */
async function autoBindShot(
  ctx: Ctx,
  projectId: number,
  shot: { title: string; visual: string; dialogue: string; promptZh: string },
  reportedNames: string[],
): Promise<number[]> {
  const d = db(ctx);
  const chars = await loadCharacters(ctx, projectId);
  const text = `${shot.title}\n${shot.visual}\n${shot.dialogue}\n${shot.promptZh}`;
  const bound = new Set<number>();
  const byName = new Map<string, number>();
  for (const c of chars) {
    byName.set(c.name, c.id);
    byName.set(baseName(c.name), c.id);
  }
  for (const c of chars) {
    if (c.name && text.includes(c.name)) bound.add(c.id);
  }
  for (const raw of reportedNames) {
    const name = raw.trim();
    if (!name) continue;
    const existing = byName.get(name) ?? byName.get(baseName(name));
    if (existing) {
      bound.add(existing);
      continue;
    }
    // A parenthesized variant of an existing group character is not new.
    if (name.includes("（") && byName.has(baseName(name))) continue;
    const inserted = await d
      .insert(schema.characters)
      .values({ projectId, name, tag: `@${name}` })
      .returning({ id: schema.characters.id });
    const id = inserted[0]!.id;
    byName.set(name, id);
    bound.add(id);
  }
  return [...bound];
}

/** Rebuild continuity pair rows for a project's current shot order. */
async function rebuildContinuity(ctx: Ctx, projectId: number) {
  const d = db(ctx);
  const shots = await loadShots(ctx, projectId);
  const existing = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
  const keep = new Set<string>();
  for (let i = 0; i + 1 < shots.length; i++) {
    const from = shots[i]!;
    const to = shots[i + 1]!;
    const key = `${from.id}:${to.id}`;
    keep.add(key);
    if (!existing.some((r) => r.fromShotId === from.id && r.toShotId === to.id)) {
      await d.insert(schema.continuity).values({ projectId, fromShotId: from.id, toShotId: to.id });
    }
  }
  for (const row of existing) {
    if (!keep.has(`${row.fromShotId}:${row.toShotId}`)) {
      await d.delete(schema.continuity).where(eq(schema.continuity.id, row.id));
    }
  }
}

/** Clear verdicts of every pair touching one of the given shots. */
async function invalidatePairs(ctx: Ctx, projectId: number, shotIds: number[]) {
  if (shotIds.length === 0) return;
  const d = db(ctx);
  const rows = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
  for (const row of rows) {
    if (shotIds.includes(row.fromShotId) || shotIds.includes(row.toShotId)) {
      await d
        .update(schema.continuity)
        .set({ verdict: null, reason: "", suggestion: "", checkedAt: null, updatedAt: now() })
        .where(eq(schema.continuity.id, row.id));
    }
  }
}

function parseIds(json: string): number[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------- stuck-shot self-healing
//
// A shot's video generation runs in a spawned background task that reports
// back through jobStep / saveShotVideo. If that task dies silently (or a
// duplicate task resets the shot's status after the video was already
// saved), the shot can sit in "generating" / "processing" forever and block
// everything downstream. The workflow must never deadlock on that:
// - a shot whose video file was saved IS done, whatever its flag says;
// - a shot stuck in generating/processing with no write-back for too long
//   is declared stuck and regenerated automatically (bounded attempts).

type ShotRow = typeof schema.shots.$inferSelect;

const GENERATING_STUCK_MS = 15 * 60 * 1000;
const PROCESSING_STUCK_MS = 5 * 60 * 1000;
const STITCH_STUCK_MS = 30 * 60 * 1000;
const MAX_AUTO_RESPAWNS = 2;

function isStuckShot(s: ShotRow, atMs: number = Date.now()): boolean {
  if (s.genStatus !== "generating" && s.genStatus !== "processing") return false;
  if (s.videoBlobKey) return false;
  const limit = s.genStatus === "processing" ? PROCESSING_STUCK_MS : GENERATING_STUCK_MS;
  return atMs - s.updatedAt.getTime() > limit;
}

/** A shot whose video was collected is done, even if its status flag was
 *  reset afterwards by a duplicate task. Only in-flight flags are healed;
 *  deliberate states (pending / failed) are left alone. */
async function reconcileShotStates(ctx: Ctx, projectId: number): Promise<void> {
  const d = db(ctx);
  const shots = await loadShots(ctx, projectId);
  for (const s of shots) {
    if (s.videoBlobKey && (s.genStatus === "generating" || s.genStatus === "processing")) {
      await d
        .update(schema.shots)
        .set({ genStatus: "done", failReason: null, quotaExceeded: 0, updatedAt: now() })
        .where(eq(schema.shots.id, s.id));
    }
  }
}

// ------------------------------------------- consistency hard gate (step 4)
//
// The user's zero-tolerance rule: a shot's people — foreground AND
// background, even half-visible — must match the bound characters' look
// anchors (gender, face, hair, costume). "done" (video saved) is not
// enough: sampled frames of the actual footage are vision-checked against
// every bound character's anchor image and hard-written features. A failed
// check regenerates the shot automatically (bounded); a shot that still
// fails stays out of the stitch until it is regenerated and passes the
// hard gate. There is NO manual exemption: passing the gate is the only
// way into the stitch.

const MAX_QA_ATTEMPTS = 2;

/** Ready for stitching: video saved AND hard gate passed. No exceptions. */
function shotReady(s: ShotRow): boolean {
  return s.genStatus === "done" && Boolean(s.videoBlobKey) && s.qaStatus === "passed";
}

/** The gate spent its automatic regenerations and the shot was parked as
 *  failed: batch/stitch drivers must not respawn it — only a manual
 *  retry (regenerate with a fresh budget, then pass the gate) moves it. */
function qaExhausted(s: ShotRow): boolean {
  return s.genStatus === "failed" && s.qaStatus === "failed" && s.qaAttempts >= MAX_QA_ATTEMPTS;
}

/** Mark every still-running single-shot video job for one shot as failed
 *  (they belong to a background task that went silent or was superseded). */
async function failActiveVideoJobs(ctx: Ctx, projectId: number, shotId: number, error: string): Promise<void> {
  const d = db(ctx);
  const rows = await d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.kind, "gen_video"), eq(schema.jobs.status, "running")));
  for (const j of rows) {
    if (jobDetail(j).shotId === shotId) {
      await patchJob(ctx, j.id, { status: "failed", error, message: "任务失败" });
    }
  }
}

// ------------------------------------------------------------ serializers

const projectOut = z.object({
  id: z.number(),
  title: z.string(),
  topic: z.string(),
  videoType: z.string(),
  aspect: z.string(),
  targetDuration: z.string(),
  audience: z.string(),
  platform: z.string(),
  tone: z.string(),
  script: z.string(),
  scriptVersion: z.number(),
  currentStep: z.number(),
  hasFinal: z.boolean(),
  finalUrl: z.string().nullable(),
  finalDurationSec: z.number().nullable(),
  finalResolution: z.string().nullable(),
  finalShotCount: z.number().nullable(),
  publishTitle: z.string(),
  publishCopy: z.string(),
  publishConfirmed: z.boolean(),
  updatedAt: z.string(),
});

const shotOut = z.object({
  id: z.number(),
  seq: z.number(),
  title: z.string(),
  durationSec: z.number(),
  visual: z.string(),
  dialogue: z.string(),
  promptZh: z.string(),
  startState: z.string(),
  endState: z.string(),
  characterIds: z.array(z.number()),
  posX: z.number(),
  posY: z.number(),
  genStatus: z.string(),
  failReason: z.string().nullable(),
  quotaExceeded: z.boolean(),
  videoUrl: z.string().nullable(),
  qaStatus: z.string(),
  qaReason: z.string(),
  qaModel: z.string(),
  qaCheckedAt: z.string().nullable(),
  qaAttempts: z.number(),
  qaMaxAttempts: z.number(),
  ready: z.boolean(),
});

const characterOut = z.object({
  id: z.number(),
  name: z.string(),
  tag: z.string(),
  appearance: z.string(),
  costume: z.string(),
  personality: z.string(),
  voice: z.string(),
  locked: z.boolean(),
  descriptionComplete: z.boolean(),
  imageUrl: z.string().nullable(),
  imageStatus: z.string(),
  imageFailReason: z.string().nullable(),
});

const continuityOut = z.object({
  id: z.number(),
  fromShotId: z.number(),
  toShotId: z.number(),
  fromSeq: z.number(),
  toSeq: z.number(),
  verdict: z.string().nullable(),
  reason: z.string(),
  suggestion: z.string(),
  modelLabel: z.string(),
});

const jobOut = z.object({
  id: z.number(),
  kind: z.string(),
  status: z.string(),
  progressDone: z.number(),
  progressTotal: z.number(),
  message: z.string(),
  error: z.string().nullable(),
});

type ProjectRow = typeof schema.projects.$inferSelect;

function serializeProject(p: ProjectRow, finalUrl: string | null) {
  return {
    id: p.id,
    title: p.title,
    topic: p.topic,
    videoType: p.videoType,
    aspect: p.aspect,
    targetDuration: p.targetDuration,
    audience: p.audience,
    platform: p.platform,
    tone: p.tone,
    script: p.script,
    scriptVersion: p.scriptVersion,
    currentStep: p.currentStep,
    hasFinal: Boolean(p.finalBlobKey),
    finalUrl,
    finalDurationSec: p.finalDurationSec,
    finalResolution: p.finalResolution,
    finalShotCount: p.finalShotCount,
    publishTitle: p.publishTitle,
    publishCopy: p.publishCopy,
    publishConfirmed: p.publishConfirmed === 1,
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------- actions

const okResponse = z.object({ ok: z.literal(true) });

export const Actions = {
  listProjects: defineAction({
    description: "列出所有视频项目（按最近更新排序），供左侧边栏切换。",
    request: z.object({}),
    response: z.object({
      projects: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          videoType: z.string(),
          currentStep: z.number(),
          shotCount: z.number(),
          doneShots: z.number(),
          hasFinal: z.boolean(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const d = db(ctx);
      const rows = await d.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt));
      const projects = [];
      for (const p of rows) {
        const shots = await loadShots(ctx, p.id);
        projects.push({
          id: p.id,
          title: p.title,
          videoType: p.videoType,
          currentStep: p.currentStep,
          shotCount: shots.length,
          doneShots: shots.filter((s) => shotReady(s)).length,
          hasFinal: Boolean(p.finalBlobKey),
          updatedAt: p.updatedAt.toISOString(),
        });
      }
      return { projects };
    },
  }),

  createProject: defineAction({
    description: "新建一个空白视频项目并返回其完整数据。",
    request: z.object({ title: z.string().max(80).optional() }),
    response: z.object({ project: projectOut }),
    async handler(ctx, args) {
      const d = db(ctx);
      const rows = await d
        .insert(schema.projects)
        .values({ title: args.title?.trim() || "未命名项目" })
        .returning();
      const p = rows[0]!;
      ctx.invalidateQueries();
      return { project: serializeProject(p, null) };
    },
  }),

  deleteProject: defineAction({
    description: "删除一个项目及其全部分镜、角色、连续性记录与任务记录。",
    request: z.object({ projectId: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      await d.delete(schema.shots).where(eq(schema.shots.projectId, args.projectId));
      await d.delete(schema.characters).where(eq(schema.characters.projectId, args.projectId));
      await d.delete(schema.continuity).where(eq(schema.continuity.projectId, args.projectId));
      await d.delete(schema.jobs).where(eq(schema.jobs.projectId, args.projectId));
      await d.delete(schema.projects).where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getProject: defineAction({
    description: "读取一个项目的全部数据：设定、脚本、分镜、角色、连续性台账、任务与成片信息。",
    request: z.object({ projectId: z.number() }),
    response: z.object({
      project: projectOut,
      shots: z.array(shotOut),
      characters: z.array(characterOut),
      continuity: z.array(continuityOut),
      jobs: z.array(jobOut),
      textModelLabel: z.string(),
    }),
    async handler(ctx, args) {
      const p = await loadProject(ctx, args.projectId);
      if (!p) throw new Error("项目不存在或已被删除。");
      const finalUrl = p.finalBlobKey ? await ctx.blobs.getUrl(p.finalBlobKey) : null;
      await reconcileShotStates(ctx, args.projectId);
      const shotRows = await loadShots(ctx, args.projectId);
      const shots = [];
      for (const s of shotRows) {
        shots.push({
          id: s.id,
          seq: s.seq,
          title: s.title,
          durationSec: s.durationSec,
          visual: s.visual,
          dialogue: s.dialogue,
          promptZh: s.promptZh,
          startState: s.startState,
          endState: s.endState,
          characterIds: parseIds(s.characterIds),
          posX: s.posX,
          posY: s.posY,
          genStatus: s.genStatus,
          failReason: s.failReason,
          quotaExceeded: s.quotaExceeded === 1,
          videoUrl: s.videoBlobKey ? await ctx.blobs.getUrl(s.videoBlobKey) : null,
          qaStatus: s.qaStatus,
          qaReason: s.qaReason,
          qaModel: s.qaModel,
          qaCheckedAt: s.qaCheckedAt ? s.qaCheckedAt.toISOString() : null,
          qaAttempts: s.qaAttempts,
          qaMaxAttempts: MAX_QA_ATTEMPTS,
          ready: shotReady(s),
        });
      }
      const charRows = await loadCharacters(ctx, args.projectId);
      const characters = [];
      for (const c of charRows) {
        characters.push({
          id: c.id,
          name: c.name,
          tag: c.tag || `@${c.name}`,
          appearance: c.appearance,
          costume: c.costume,
          personality: c.personality,
          voice: c.voice,
          locked: c.locked === 1,
          descriptionComplete: characterComplete(c),
          imageUrl: c.imageBlobKey ? await ctx.blobs.getUrl(c.imageBlobKey) : null,
          imageStatus: c.imageStatus,
          imageFailReason: c.imageFailReason,
        });
      }
      const d = db(ctx);
      const contRows = await d
        .select()
        .from(schema.continuity)
        .where(eq(schema.continuity.projectId, args.projectId))
        .orderBy(asc(schema.continuity.id));
      const seqById = new Map(shotRows.map((s) => [s.id, s.seq]));
      const continuity = contRows.map((r) => ({
        id: r.id,
        fromShotId: r.fromShotId,
        toShotId: r.toShotId,
        fromSeq: seqById.get(r.fromShotId) ?? 0,
        toSeq: seqById.get(r.toShotId) ?? 0,
        verdict: r.verdict,
        reason: r.reason,
        suggestion: r.suggestion,
        modelLabel: r.modelLabel,
      }));
      const jobRows = await d
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.projectId, args.projectId))
        .orderBy(desc(schema.jobs.id))
        .limit(12);
      const jobs = jobRows.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        progressDone: j.progressDone,
        progressTotal: j.progressTotal,
        message: j.message,
        error: j.error,
      }));
      return {
        project: serializeProject(p, finalUrl),
        shots,
        characters,
        continuity,
        jobs,
        textModelLabel: await modelLabel(ctx),
      };
    },
  }),

  updateProjectSettings: defineAction({
    description: "保存第一步的选题与设定（题材、类型、画幅、时长、受众、平台、基调、标题）。",
    request: z.object({
      projectId: z.number(),
      title: z.string().max(80).optional(),
      topic: z.string().max(2000).optional(),
      videoType: z.string().max(40).optional(),
      aspect: z.enum(["9:16", "16:9"]).optional(),
      targetDuration: z.string().max(40).optional(),
      audience: z.string().max(200).optional(),
      platform: z.string().max(40).optional(),
      tone: z.string().max(200).optional(),
      currentStep: z.number().int().min(1).max(6).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      const values: Record<string, unknown> = { updatedAt: now() };
      for (const key of ["title", "topic", "videoType", "aspect", "targetDuration", "audience", "platform", "tone", "currentStep"] as const) {
        if (args[key] !== undefined) values[key] = args[key];
      }
      await d.update(schema.projects).set(values).where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  saveScript: defineAction({
    description: "保存用户粘贴或编辑后的脚本（覆盖当前脚本并递增版本号，正在运行的生成任务不受影响）。",
    request: z.object({ projectId: z.number(), script: z.string().max(60000) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const p = await loadProject(ctx, args.projectId);
      if (!p) throw new Error("项目不存在。");
      const d = db(ctx);
      await d
        .update(schema.projects)
        .set({ script: args.script, scriptVersion: p.scriptVersion + 1, updatedAt: now() })
        .where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateShot: defineAction({
    description: "编辑一张分镜卡的任意字段（标题、时长、画面、台词、中文提示词、开场/结尾状态、出场人物、画布位置）。内容变更会使相邻连续性结论失效待复查。",
    request: z.object({
      shotId: z.number(),
      title: z.string().max(120).optional(),
      durationSec: z.number().positive().max(120).optional(),
      visual: z.string().max(4000).optional(),
      dialogue: z.string().max(2000).optional(),
      promptZh: z.string().max(4000).optional(),
      startState: z.string().max(2000).optional(),
      endState: z.string().max(2000).optional(),
      characterIds: z.array(z.number()).optional(),
      posX: z.number().optional(),
      posY: z.number().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      const rows = await d.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      const shot = rows[0];
      if (!shot) throw new Error("分镜不存在。");
      const values: Record<string, unknown> = { updatedAt: now() };
      let contentChanged = false;
      for (const key of ["title", "visual", "dialogue", "promptZh", "startState", "endState"] as const) {
        if (args[key] !== undefined) {
          values[key] = args[key];
          if (args[key] !== shot[key]) contentChanged = true;
        }
      }
      if (args.durationSec !== undefined) values.durationSec = args.durationSec;
      if (args.posX !== undefined) values.posX = args.posX;
      if (args.posY !== undefined) values.posY = args.posY;
      const bindingsChanged =
        args.characterIds !== undefined && JSON.stringify(args.characterIds) !== shot.characterIds;
      if ((contentChanged || bindingsChanged) && shot.videoBlobKey) {
        // The saved footage no longer matches the edited text/bindings: it
        // must pass the frame hard-check again before stitching.
        values.qaStatus = "pending";
        values.qaReason = "";
        values.qaModel = "";
        values.qaCheckedAt = null;
        values.qaAttempts = 0;
        values.verifyExempt = 0;
      }
      if (args.characterIds !== undefined) {
        values.characterIds = JSON.stringify(args.characterIds);
      } else if (contentChanged) {
        const merged = {
          title: args.title ?? shot.title,
          visual: args.visual ?? shot.visual,
          dialogue: args.dialogue ?? shot.dialogue,
          promptZh: args.promptZh ?? shot.promptZh,
        };
        const chars = await loadCharacters(ctx, shot.projectId);
        const ids = chars.filter((c) => c.name && `${merged.title}\n${merged.visual}\n${merged.dialogue}\n${merged.promptZh}`.includes(c.name)).map((c) => c.id);
        values.characterIds = JSON.stringify(ids);
      }
      await d.update(schema.shots).set(values).where(eq(schema.shots.id, args.shotId));
      if (contentChanged) await invalidatePairs(ctx, shot.projectId, [args.shotId]);
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  addShot: defineAction({
    description: "在分镜链末尾手动新增一张空白分镜卡，并重建连线与连续性台账行。",
    request: z.object({ projectId: z.number() }),
    response: z.object({ shotId: z.number() }),
    async handler(ctx, args) {
      const d = db(ctx);
      const shots = await loadShots(ctx, args.projectId);
      const seq = shots.length + 1;
      const last = shots[shots.length - 1];
      const rows = await d
        .insert(schema.shots)
        .values({
          projectId: args.projectId,
          seq,
          title: `第 ${seq} 镜`,
          startState: last ? last.endState : "",
          posX: last ? last.posX + 40 : 24,
          posY: last ? last.posY + 300 : 24,
        })
        .returning({ id: schema.shots.id });
      await rebuildContinuity(ctx, args.projectId);
      await touchProject(ctx, args.projectId);
      ctx.invalidateQueries();
      return { shotId: rows[0]!.id };
    },
  }),

  deleteShot: defineAction({
    description: "删除一张分镜卡，重新编排镜号并重建连续性台账行（已生成的其他镜头视频不受影响）。",
    request: z.object({ shotId: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      const rows = await d.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      const shot = rows[0];
      if (!shot) throw new Error("分镜不存在。");
      await d.delete(schema.shots).where(eq(schema.shots.id, args.shotId));
      const rest = await loadShots(ctx, shot.projectId);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i]!.seq !== i + 1) {
          await d.update(schema.shots).set({ seq: i + 1, updatedAt: now() }).where(eq(schema.shots.id, rest[i]!.id));
        }
      }
      await rebuildContinuity(ctx, shot.projectId);
      await touchProject(ctx, shot.projectId);
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  upsertCharacter: defineAction({
    description: "新建或编辑一个角色的定妆信息（名字、@标签、外貌、服装、性格、声音、锁定状态）。编辑不会动已生成的定妆图。",
    request: z.object({
      projectId: z.number(),
      characterId: z.number().optional(),
      name: z.string().min(1).max(40),
      appearance: z.string().max(2000).optional(),
      costume: z.string().max(2000).optional(),
      personality: z.string().max(2000).optional(),
      voice: z.string().max(1000).optional(),
      locked: z.boolean().optional(),
    }),
    response: z.object({ characterId: z.number() }),
    async handler(ctx, args) {
      const d = db(ctx);
      const name = args.name.trim();
      if (args.characterId) {
        const values: Record<string, unknown> = { updatedAt: now(), name, tag: `@${name}` };
        for (const key of ["appearance", "costume", "personality", "voice"] as const) {
          if (args[key] !== undefined) values[key] = args[key];
        }
        if (args.locked !== undefined) values.locked = args.locked ? 1 : 0;
        await d.update(schema.characters).set(values).where(eq(schema.characters.id, args.characterId));
        ctx.invalidateQueries();
        return { characterId: args.characterId };
      }
      const existing = (await loadCharacters(ctx, args.projectId)).find(
        (c) => c.name === name || baseName(c.name) === baseName(name),
      );
      if (existing) return { characterId: existing.id };
      const rows = await d
        .insert(schema.characters)
        .values({
          projectId: args.projectId,
          name,
          tag: `@${name}`,
          appearance: args.appearance ?? "",
          costume: args.costume ?? "",
          personality: args.personality ?? "",
          voice: args.voice ?? "",
          locked: args.locked ? 1 : 0,
        })
        .returning({ id: schema.characters.id });
      await touchProject(ctx, args.projectId);
      ctx.invalidateQueries();
      return { characterId: rows[0]!.id };
    },
  }),

  deleteCharacter: defineAction({
    description: "删除一个角色，并把它从所有分镜的出场人物绑定中移除（定妆图记录一并删除）。",
    request: z.object({ characterId: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      const rows = await d.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      const c = rows[0];
      if (!c) throw new Error("角色不存在。");
      if (c.imageBlobKey) await ctx.blobs.delete(c.imageBlobKey).catch(() => undefined);
      await d.delete(schema.characters).where(eq(schema.characters.id, args.characterId));
      const shots = await loadShots(ctx, c.projectId);
      for (const s of shots) {
        const ids = parseIds(s.characterIds);
        if (ids.includes(args.characterId)) {
          await d
            .update(schema.shots)
            .set({ characterIds: JSON.stringify(ids.filter((i) => i !== args.characterId)), updatedAt: now() })
            .where(eq(schema.shots.id, s.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  savePublishCopy: defineAction({
    description: "保存第六步的发布标题与文案，并记录用户是否已确认（确认前绝不发布）。",
    request: z.object({
      projectId: z.number(),
      publishTitle: z.string().max(200),
      publishCopy: z.string().max(4000),
      confirmed: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      await d
        .update(schema.projects)
        .set({
          publishTitle: args.publishTitle,
          publishCopy: args.publishCopy,
          publishConfirmed: args.confirmed ? 1 : 0,
          updatedAt: now(),
        })
        .where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getSettings: defineAction({
    description: "读取文本模型设置：来源（Muse 或自定义）、自定义接口地址、模型名称与 API Key 掩码（不回明文）。",
    request: z.object({}),
    response: z.object({
      textSource: z.string(),
      customBaseUrl: z.string(),
      customModel: z.string(),
      apiKeyMasked: z.string(),
      hasApiKey: z.boolean(),
    }),
    async handler(ctx) {
      const s = await getSettingsRow(ctx);
      return {
        textSource: s.textSource,
        customBaseUrl: s.customBaseUrl,
        customModel: s.customModel,
        apiKeyMasked: maskKey(s.customApiKey),
        hasApiKey: Boolean(s.customApiKey),
      };
    },
  }),

  updateSettings: defineAction({
    description: "保存文本模型设置。API Key 留空表示保留原 Key 不变；切换来源即时对新任务生效，不影响在跑任务与已存数据。",
    request: z.object({
      textSource: z.enum(["muse", "custom"]),
      customBaseUrl: z.string().max(500).optional(),
      customModel: z.string().max(120).optional(),
      customApiKey: z.string().max(500).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const d = db(ctx);
      const values: Record<string, unknown> = { textSource: args.textSource, updatedAt: now() };
      if (args.customBaseUrl !== undefined) values.customBaseUrl = args.customBaseUrl.trim();
      if (args.customModel !== undefined) values.customModel = args.customModel.trim();
      if (args.customApiKey !== undefined && args.customApiKey.trim() !== "") {
        values.customApiKey = args.customApiKey.trim();
      }
      await d.update(schema.settings).set(values).where(eq(schema.settings.id, 1));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  testCustomConnection: defineAction({
    description: "用当前填写的自定义模型参数发一条最小测试请求，明确返回连接成功或失败的具体原因。",
    request: z.object({
      customBaseUrl: z.string().min(1).max(500),
      customModel: z.string().min(1).max(120),
      customApiKey: z.string().max(500).optional(),
    }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const s = await getSettingsRow(ctx);
      const apiKey = args.customApiKey?.trim() || s.customApiKey;
      if (!apiKey) return { ok: false, message: "还没有填写 API Key，无法测试连接。" };
      const base = args.customBaseUrl.replace(/\/+$/, "");
      try {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: args.customModel,
            messages: [{ role: "user", content: "请只回复：连接成功" }],
            max_tokens: 16,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          return { ok: false, message: classifyCustomError(res.status, await res.text().catch(() => "")) };
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const reply = data.choices?.[0]?.message?.content?.trim();
        return {
          ok: true,
          message: reply ? `连接成功，模型已响应：「${reply.slice(0, 40)}」` : "连接成功，模型已响应。",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("timed out") || msg.includes("TimeoutError") || msg.includes("abort")) {
          return { ok: false, message: "连接超时（30 秒未响应），请检查接口地址是否可达。" };
        }
        return { ok: false, message: `连接失败：${msg.slice(0, 200)}` };
      }
    },
  }),

  startJob: defineAction({
    description: "启动一个后台任务（生成脚本、拆分镜、提取角色、补描述、生成定妆图、连续性检查、一键修复、生成视频、单镜人物一致性硬验、拼接成片、整理发布文案）。视频生成后必须过抽帧硬验（逐人比对定妆锚图，含背景人物），不过自动重生成，未通过不许拼接。立即返回任务 id，进度靠 advanceJob 分步推进；同类任务在跑时不会重复启动。",
    request: z.object({
      projectId: z.number(),
      kind: z.enum([
        "script",
        "storyboard",
        "extract_characters",
        "describe_character",
        "describe_all",
        "look_image",
        "look_all",
        "check_continuity",
        "fix_continuity",
        "publish_copy",
        "gen_video",
        "gen_all_videos",
        "verify_shot",
        "stitch",
      ]),
      shotId: z.number().optional(),
      characterId: z.number().optional(),
    }),
    response: z.object({ jobId: z.number(), alreadyRunning: z.boolean() }),
    async handler(ctx, args) {
      const project = await loadProject(ctx, args.projectId);
      if (!project) throw new Error("项目不存在。");
      const d = db(ctx);
      const kind = args.kind;

      if (kind === "gen_video" || kind === "gen_all_videos" || kind === "verify_shot" || kind === "stitch") {
        await reconcileShotStates(ctx, args.projectId);
      }

      const existing = await findActiveJob(ctx, args.projectId, kind);
      if (existing) {
        if (kind !== "gen_video") {
          return { jobId: existing.id, alreadyRunning: true };
        }
        if (jobDetail(existing).shotId === args.shotId) {
          // The same shot already has a generation job. If that job's shot
          // is stuck (its background task went silent), retire the old job
          // and fall through to spawn a fresh generation instead of
          // refusing — a stuck shot must always be regenerable.
          const shotsNow = await loadShots(ctx, args.projectId);
          const stuckShot = shotsNow.find((s) => s.id === args.shotId);
          if (stuckShot && isStuckShot(stuckShot)) {
            await patchJob(ctx, existing.id, {
              status: "failed",
              error: "生成长时间无回写，判定卡住，已被新的生成任务接管。",
              message: "任务失败",
            });
          } else {
            return { jobId: existing.id, alreadyRunning: true };
          }
        }
      }

      if (kind === "script") {
        const jobId = await createJob(ctx, args.projectId, kind, { prevScript: project.script }, "正在生成脚本…", 1);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "storyboard") {
        if (!project.script.trim()) throw new Error("脚本还是空的，请先在第二步生成或粘贴脚本。");
        const shots = await loadShots(ctx, args.projectId);
        if (shots.length > 0) {
          await d.delete(schema.shots).where(eq(schema.shots.projectId, args.projectId));
          await d.delete(schema.continuity).where(eq(schema.continuity.projectId, args.projectId));
          await d
            .update(schema.projects)
            .set({ finalBlobKey: null, finalDurationSec: null, finalResolution: null, finalShotCount: null, updatedAt: now() })
            .where(eq(schema.projects.id, args.projectId));
        }
        const total = splitScript(project.script).length;
        const jobId = await createJob(ctx, args.projectId, kind, { chunkIndex: 0 }, "正在拆分镜…", total);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "extract_characters") {
        if (!project.script.trim()) throw new Error("脚本还是空的，无法提取角色。");
        const total = splitScript(project.script).length;
        const jobId = await createJob(
          ctx,
          args.projectId,
          kind,
          { phase: "extract", chunkIndex: 0 },
          "正在从脚本分段提取角色…",
          total,
        );
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "describe_character") {
        if (!args.characterId) throw new Error("缺少角色 id。");
        const jobId = await createJob(ctx, args.projectId, kind, { characterId: args.characterId }, "正在生成角色描述…", 1);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "describe_all") {
        const chars = await loadCharacters(ctx, args.projectId);
        const targets = chars.filter((c) => !characterComplete(c));
        if (targets.length === 0) throw new Error("所有角色的描述都已完整，没有待补的角色。");
        const jobId = await createJob(ctx, args.projectId, kind, {}, "正在逐个补齐角色描述…", targets.length);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "look_image") {
        if (!args.characterId) throw new Error("缺少角色 id。");
        const chars = await loadCharacters(ctx, args.projectId);
        const c = chars.find((x) => x.id === args.characterId);
        if (!c) throw new Error("角色不存在。");
        await d
          .update(schema.characters)
          .set({ imageStatus: "generating", imageFailReason: null, updatedAt: now() })
          .where(eq(schema.characters.id, c.id));
        const jobId = await createJob(ctx, args.projectId, kind, { characterId: c.id }, `正在生成 ${c.name} 的定妆图…`, 1);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "look_all") {
        const chars = await loadCharacters(ctx, args.projectId);
        const targets = chars.filter((c) => !c.imageBlobKey);
        if (targets.length === 0) throw new Error("所有角色都已有定妆图，没有待生成的。");
        const jobId = await createJob(ctx, args.projectId, kind, {}, "正在并发生成定妆图（一批 3 个）…", targets.length);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "check_continuity") {
        const shots = await loadShots(ctx, args.projectId);
        if (shots.length < 2) throw new Error("至少需要两个分镜才能做连续性检查。");
        await rebuildContinuity(ctx, args.projectId);
        const total = shots.length - 1;
        const jobId = await createJob(ctx, args.projectId, kind, {}, "正在并发核对相邻分镜…", total);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "fix_continuity") {
        const rows = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, args.projectId));
        const bad = rows.filter((r) => r.verdict === "jump" || r.verdict === "broken");
        if (bad.length === 0) throw new Error("当前没有小跳跃或衔接断裂的问题，请先做一次连续性检查。");
        const jobId = await createJob(ctx, args.projectId, kind, { phase: "fix" }, "正在并发修复衔接问题…", bad.length);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "publish_copy") {
        const jobId = await createJob(ctx, args.projectId, kind, {}, "正在整理发布标题与文案…", 1);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "gen_video") {
        if (!args.shotId) throw new Error("缺少分镜 id。");
        const shots = await loadShots(ctx, args.projectId);
        const shot = shots.find((s) => s.id === args.shotId);
        if (!shot) throw new Error("分镜不存在。");
        if (shotReady(shot)) {
          throw new Error("这一镜已经生成完成并通过人物一致性硬验，不会重复生成。");
        }
        if (shot.quotaExceeded === 1) throw new Error("这一镜上次失败是因为视频生成额度用完，请等额度恢复后再重试，不要反复点击。");
        if (shot.genStatus === "done" && shot.videoBlobKey) {
          // Saved footage that has not passed the hard gate: a manual
          // re-generation discards it and starts over with a fresh QA
          // budget. (Footage still awaiting its first check is NOT
          // discarded — verify_shot checks it as-is.)
          if (shot.qaStatus !== "failed") {
            throw new Error("这一镜的视频已生成、正在等待抽帧硬验，不需要重新生成；硬验不通过时工作流会自动重生成。");
          }
          await ctx.blobs.delete(shot.videoBlobKey).catch(() => undefined);
          await d
            .update(schema.shots)
            .set({
              videoBlobKey: null,
              genStatus: "pending",
              failReason: null,
              qaStatus: "pending",
              qaReason: "",
              qaAttempts: 0,
              verifyExempt: 0,
              updatedAt: now(),
            })
            .where(eq(schema.shots.id, shot.id));
        }
        const jobId = await createJob(ctx, args.projectId, kind, { shotId: shot.id }, `正在生成第 ${shot.seq} 镜的真视频…`, 1);
        await spawnVideoTask(ctx, args.projectId, shot.id, jobId);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "verify_shot") {
        if (!args.shotId) throw new Error("缺少分镜 id。");
        const shots = await loadShots(ctx, args.projectId);
        const shot = shots.find((s) => s.id === args.shotId);
        if (!shot) throw new Error("分镜不存在。");
        if (shot.genStatus !== "done" || !shot.videoBlobKey) throw new Error("这一镜还没有生成出视频，先生成视频再硬验。");
        if (shotReady(shot)) throw new Error("这一镜已经通过人物一致性硬验，不需要重复硬验。");
        const jobId = await createJob(ctx, args.projectId, kind, { shotId: shot.id }, `正在抽帧硬验第 ${shot.seq} 镜的人物一致性…`, 1);
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      if (kind === "gen_all_videos") {
        const shots = await loadShots(ctx, args.projectId);
        const targets = shots.filter((s) => !shotReady(s));
        if (targets.length === 0) throw new Error("所有分镜都已生成完成并通过人物一致性硬验。");
        const jobId = await createJob(
          ctx,
          args.projectId,
          kind,
          { shotIds: targets.map((s) => s.id) },
          "正在并发生成全部视频（一批最多 6 条）…",
          targets.length,
        );
        ctx.invalidateQueries();
        return { jobId, alreadyRunning: false };
      }

      // stitch — never hard-blocked by an unfinished shot. When some shots
      // are missing or stuck, the job first regenerates them (driven step
      // by step in stepJob) and dispatches the actual stitch task only
      // once every shot is ready.
      const shots = await loadShots(ctx, args.projectId);
      if (shots.length === 0) throw new Error("还没有分镜，无法拼接。");
      const missing = shots.filter((s) => !shotReady(s));
      const jobId = await createJob(
        ctx,
        args.projectId,
        kind,
        { finalKeyBefore: project.finalBlobKey ?? "" },
        missing.length === 0
          ? "正在拼接成片（保留原声、烧录字幕）…"
          : `还有 ${missing.length} 镜未就绪（第 ${missing.map((s) => s.seq).join("、")} 镜）：未生成的先补生成，已生成但未过人物一致性硬验的先复验/重生成，全部通过硬验后自动拼接…`,
        shots.length,
      );
      // No agent task is spawned for stitching: the job is driven by
      // advanceJob polling, which runs ffmpeg as a detached background
      // process (see driveStitch) — a synchronous stitch call always
      // blows the ~30s invoke limit.
      ctx.invalidateQueries();
      return { jobId, alreadyRunning: false };
    },
  }),

  advanceJob: defineAction({
    description: "推进一个后台任务一小步并返回最新状态。文本与图片任务在这一步里真正干活并落库；视频与拼接任务在这一步同步子任务状态，并自愈卡住的镜头（补收已生成未收片的原片、自动重新生成无回写的镜头）。",
    request: z.object({ jobId: z.number() }),
    privileged: [privileged.readFileChunk, privileged.stitchBackground, privileged.extractFrames, privileged.readBlobImage],
    response: z.object({ job: jobOut, advanced: z.boolean() }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job) throw new Error("任务不存在。");
      const serialize = (j: typeof job) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        progressDone: j.progressDone,
        progressTotal: j.progressTotal,
        message: j.message,
        error: j.error,
      });
      if (job.status !== "running") return { job: serialize(job), advanced: false };
      try {
        await stepJob(ctx, job);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await patchJob(ctx, job.id, { status: "failed", error: msg.slice(0, 500), message: "任务失败" });
      }
      const after = await loadJob(ctx, args.jobId);
      ctx.invalidateQueries();
      return { job: serialize(after ?? job), advanced: true };
    },
  }),

  retryJob: defineAction({
    description: "重试一个失败的后台任务：沿用原任务的进度断点，只补没完成的部分，已保存的成果不丢失。",
    request: z.object({ jobId: z.number() }),
    response: z.object({ jobId: z.number() }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job) throw new Error("任务不存在。");
      if (job.status !== "failed") throw new Error("只有失败的任务可以重试。");
      if (!job.projectId) throw new Error("任务缺少项目信息，无法重试。");
      const detail = jobDetail(job);
      const newId = await createJob(ctx, job.projectId, job.kind, detail, "重试中…", job.progressTotal);
      if (job.kind === "gen_video" && typeof detail.shotId === "number") {
        await reconcileShotStates(ctx, job.projectId);
        const shotsNow = await loadShots(ctx, job.projectId);
        const shotNow = shotsNow.find((s) => s.id === detail.shotId);
        if (shotNow && shotReady(shotNow)) {
          await patchJob(ctx, newId, {
            status: "done",
            progressDone: 1,
            progressTotal: 1,
            message: "这一镜的视频已经保存好并通过人物一致性硬验，无需重新生成。",
          });
          ctx.invalidateQueries();
          return { jobId: newId };
        }
        const d = db(ctx);
        if (shotNow?.genStatus === "done" && shotNow.videoBlobKey && shotNow.qaStatus !== "failed") {
          // The footage exists and never got a fail verdict — the failure
          // happened inside the gate check itself (e.g. frame extraction
          // or the vision call). Retry as a pure verification job; do NOT
          // regenerate the video.
          const verifyId = await createJob(
            ctx,
            job.projectId,
            "verify_shot",
            { shotId: detail.shotId },
            "重试中：正在重新抽帧硬验人物一致性…",
            1,
          );
          await patchJob(ctx, newId, {
            status: "done",
            progressDone: 1,
            progressTotal: 1,
            message: "已转为硬验重试：只重新抽帧核对，不重新生成视频。",
          });
          ctx.invalidateQueries();
          return { jobId: verifyId };
        }
        if (shotNow?.genStatus === "done" && shotNow.videoBlobKey) {
          // The failed job was the hard gate running out of automatic
          // regenerations: discard the rejected footage and start fresh.
          await ctx.blobs.delete(shotNow.videoBlobKey).catch(() => undefined);
          await d
            .update(schema.shots)
            .set({
              videoBlobKey: null,
              genStatus: "pending",
              failReason: null,
              qaStatus: "pending",
              qaReason: "",
              qaAttempts: 0,
              verifyExempt: 0,
              quotaExceeded: 0,
              updatedAt: now(),
            })
            .where(eq(schema.shots.id, detail.shotId));
        } else {
          // A manual retry restarts the shot with a fresh hard-gate budget.
          await d
            .update(schema.shots)
            .set({ quotaExceeded: 0, qaAttempts: 0, updatedAt: now() })
            .where(eq(schema.shots.id, detail.shotId));
        }
        await spawnVideoTask(ctx, job.projectId, detail.shotId, newId);
      }
      if (job.kind === "stitch") {
        // Fresh stitch state: the retried job re-runs the background
        // stitch from scratch (finished segments are reused on disk).
        const p = await loadProject(ctx, job.projectId);
        await patchJob(ctx, newId, {
          detail: { finalKeyBefore: p?.finalBlobKey ?? "" },
          message: "重试中：正在重新拼接…",
        });
      }
      ctx.invalidateQueries();
      return { jobId: newId };
    },
  }),

  jobStep: defineAction({
    description: "后台视频/拼接任务的回写通道：claim 领取任务说明，generated 标记原片已生成，finish/fail 汇报结果。由被派发的 Muse 任务调用。",
    request: z.object({
      jobId: z.number(),
      phase: z.enum(["claim", "generated", "finish", "fail"]),
      sourcePath: z.string().max(1000).optional(),
      durationSec: z.number().positive().max(600).optional(),
      error: z.string().max(1000).optional(),
      quotaExceeded: z.boolean().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      instruction: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job || !job.projectId) return { ok: false, instruction: "任务不存在或缺少项目。", payload: {} };
      const detail = jobDetail(job);
      const d = db(ctx);

      if (args.phase === "fail") {
        const error = (args.error ?? "后台任务失败，未提供具体原因。").slice(0, 500);
        const quota = args.quotaExceeded === true || error.includes("额度");
        await patchJob(ctx, job.id, { status: "failed", error, message: "任务失败" });
        if (job.kind === "gen_video" && typeof detail.shotId === "number") {
          const shotsNow = await loadShots(ctx, job.projectId);
          const shotNow = shotsNow.find((s) => s.id === detail.shotId);
          if (shotNow?.videoBlobKey) {
            // The video was already collected; a late failure report from
            // a duplicate task must not clobber the finished shot.
            await d
              .update(schema.shots)
              .set({ genStatus: "done", failReason: null, quotaExceeded: 0, updatedAt: now() })
              .where(eq(schema.shots.id, shotNow.id));
          } else if (typeof detail.sourcePath === "string" && detail.sourcePath) {
            // The clip itself was generated but collection did not finish:
            // keep it in "processing" so the job's next step retries the
            // collection instead of regenerating (and burning quota).
            await d
              .update(schema.shots)
              .set({ genStatus: "processing", updatedAt: now() })
              .where(eq(schema.shots.id, detail.shotId));
          } else {
            await d
              .update(schema.shots)
              .set({
                genStatus: "failed",
                failReason: quota ? `视频生成额度已用完：${error}` : error,
                quotaExceeded: quota ? 1 : 0,
                updatedAt: now(),
              })
              .where(eq(schema.shots.id, detail.shotId));
          }
        }
        ctx.invalidateQueries();
        return { ok: true, instruction: "已记录失败。", payload: {} };
      }

      if (job.kind === "gen_video") {
        const shotId = typeof detail.shotId === "number" ? detail.shotId : 0;
        const shots = await loadShots(ctx, job.projectId);
        const idx = shots.findIndex((s) => s.id === shotId);
        const shot = shots[idx];
        if (!shot) return { ok: false, instruction: "分镜不存在，任务终止。", payload: {} };
        if (args.phase === "generated") {
          await d
            .update(schema.shots)
            .set({ genStatus: "processing", updatedAt: now() })
            .where(eq(schema.shots.id, shot.id));
          await patchJob(ctx, job.id, {
            message: "原片已生成，正在收片处理…",
            detail: { ...detail, sourcePath: args.sourcePath ?? "", durationSec: args.durationSec ?? shot.durationSec },
          });
          ctx.invalidateQueries();
          return {
            ok: true,
            instruction: "已进入收片处理。请立刻调用 saveShotVideo 完成收片（参数见 payload）。",
            payload: { shotId: shot.id, jobId: job.id, sourcePath: args.sourcePath ?? "" },
          };
        }
        if (args.phase === "finish") {
          const fresh = (await loadShots(ctx, job.projectId)).find((s) => s.id === shotId);
          if (fresh && shotReady(fresh)) {
            await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "视频生成完成，人物一致性硬验已通过" });
            ctx.invalidateQueries();
            return { ok: true, instruction: "任务完成。", payload: {} };
          }
          if (fresh?.genStatus === "done") {
            // Footage is collected, but the consistency hard gate has not
            // passed yet. Keep the job running: the workflow's polling
            // driver runs the frame check next and regenerates the shot
            // automatically if it fails. The spawned task is done either way.
            await patchJob(ctx, job.id, { message: "原片已收片，正在抽帧硬验人物一致性（不通过会自动重生成）…" });
            ctx.invalidateQueries();
            return {
              ok: true,
              instruction:
                "收片完成，本任务到此结束：人物一致性硬验由工作流自动进行，不通过会自动重新生成这一镜，你不需要再做任何事。",
              payload: {},
            };
          }
          return { ok: false, instruction: "这一镜还没有收片成功，请先调用 saveShotVideo。", payload: { shotId, jobId: job.id } };
        }
        // claim
        const chars = await loadCharacters(ctx, job.projectId);
        const bound = chars.filter((c) => parseIds(shot.characterIds).includes(c.id));
        const project = await loadProject(ctx, job.projectId);
        const prev = idx > 0 ? shots[idx - 1] : undefined;
        return {
          ok: true,
          instruction:
            "按 payload 生成这一镜的真视频，人物一致性是硬门禁，必须严格执行 payload.hardRules：把 payload.characters 里每一个角色（包括只在背景出现的人物）的定妆图都作为参考图带入生成，并把每个人的性别、外貌、发型与服装特征逐字写进生成提示词锁死；画面里不允许出现名单之外的任何人物。承接上一镜结尾状态；台词由画面人物开口说出并做口型同步，旁白才用画外音；必须有环境音/背景音乐；不要烧字幕。生成后先 jobStep(generated) 再 saveShotVideo 收片。注意：收片后工作流会抽帧硬验——逐帧比对每个出镜人物（含背景人物）与定妆锚图，不通过会自动作废并重新生成这一镜，所以务必按锚图与写死特征生成。",
          payload: {
            shotId: shot.id,
            seq: shot.seq,
            title: shot.title,
            promptZh: shot.promptZh,
            visual: shot.visual,
            dialogue: shot.dialogue,
            durationSec: shot.durationSec,
            aspect: project?.aspect ?? "9:16",
            videoType: project?.videoType ?? "",
            startState: shot.startState,
            endState: shot.endState,
            prevEndState: prev ? prev.endState : "",
            characters: bound.map((c) => ({
              name: c.name,
              appearance: c.appearance,
              costume: c.costume,
              personality: c.personality,
              voice: c.voice,
              imageBlobKey: c.imageBlobKey ?? "",
              mustMatch: `【${c.name} 写死特征，生成时逐字带入提示词】性别与外貌：${c.appearance}；服装（颜色与款式全程不变）：${c.costume}`,
            })),
            hardRules: [
              "全员锚图：characters 中每个角色的定妆图都要作为参考图传入生成——包括只在背景、远景出现的人物，背景人物同样锁脸、锁性别、锁服装。",
              "特征写死：把每个角色 mustMatch 中的性别、外貌、发型、服装颜色与款式逐字写进生成提示词，不允许改性别、换脸、换发型、换衣服颜色或款式。",
              "名单外零人物：画面中不得出现 characters 名单之外的任何人物——背景、远景、路人、只露半张脸或半个身子的人都不行；原脚本若提到未绑定的背景人物，一律不生成该人物。",
              "硬验门禁：收片后工作流会从成片中抽帧，逐人（含背景人物）与定妆锚图和写死特征比对；任何一个人对不上（性别/脸/发型/服装）整镜判不过、自动作废重生成。",
            ],
            lookImageHelp:
              "定妆图文件在磁盘上的定位：对 imageBlobKey 计算 sha256，文件位于 ~/workspace/ts-spaces/shi-pin-sheng-cheng-gong-zuo-liu/blobs/objects/<sha256 前 2 位>/<完整 sha256>；若不存在，再试 blobs/objects/<imageBlobKey 原文>。把找到的全部定妆图作为参考图传给视频生成。",
          },
        };
      }

      if (job.kind === "stitch") {
        if (args.phase === "finish") {
          const project = await loadProject(ctx, job.projectId);
          if (project?.finalBlobKey && project.finalBlobKey !== String(detail.finalKeyBefore ?? "")) {
            await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "拼接成片完成" });
            ctx.invalidateQueries();
            return { ok: true, instruction: "任务完成。", payload: {} };
          }
          return { ok: false, instruction: "成片还没有生成，请先调用 executeStitch。", payload: { jobId: job.id } };
        }
        return {
          ok: true,
          instruction:
            "请调用 artifact 动作 executeStitch（参数 {\"jobId\": 本任务 id}）推进拼接：ffmpeg 在后台独立进程中运行，executeStitch 本身不会超时。返回 ok:false 表示后台拼接进行中：等 20 秒后再次调用 executeStitch，直到返回 ok:true 后调用 jobStep(finish)；若 executeStitch 抛出错误，把错误原文调用 jobStep(fail)。最多等待约 20 分钟。",
          payload: { jobId: job.id, projectId: job.projectId },
        };
      }

      return { ok: false, instruction: `任务类型 ${job.kind} 不通过 jobStep 回写。`, payload: {} };
    },
  }),

  saveShotVideo: defineAction({
    description: "收片：把后台任务生成好的分镜视频文件收进本空间存储，标记该镜已完成并记录实际时长。由视频生成任务在 jobStep(generated) 之后调用。",
    request: z.object({
      shotId: z.number(),
      jobId: z.number(),
      sourcePath: z.string().min(1).max(1000),
    }),
    privileged: [privileged.readFileChunk],
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const d = db(ctx);
      const rows = await d.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      const shot = rows[0];
      if (!shot) return { ok: false, message: "分镜不存在，收片失败。" };
      const job = await loadJob(ctx, args.jobId);
      const detail = job ? jobDetail(job) : {};
      const key = `videos/project-${shot.projectId}/shot-${shot.id}-${args.jobId}.mp4`;
      try {
        await collectFileToBlob(ctx, args.sourcePath, key, "video/mp4");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await d
          .update(schema.shots)
          .set({ genStatus: "failed", failReason: `收片失败：${msg.slice(0, 300)}`, updatedAt: now() })
          .where(eq(schema.shots.id, shot.id));
        // Only fail the job that actually owns this shot; a collection
        // attempt reported against another (duplicate) job must not kill it.
        if (job && job.status === "running" && jobDetail(job).shotId === shot.id) {
          await patchJob(ctx, job.id, { status: "failed", error: `收片失败：${msg.slice(0, 300)}`, message: "任务失败" });
        }
        ctx.invalidateQueries();
        return { ok: false, message: `收片失败：${msg.slice(0, 300)}` };
      }
      if (shot.videoBlobKey && shot.videoBlobKey !== key) {
        await ctx.blobs.delete(shot.videoBlobKey).catch(() => undefined);
      }
      const actualDuration = typeof detail.durationSec === "number" ? detail.durationSec : shot.durationSec;
      await d
        .update(schema.shots)
        .set({
          genStatus: "done",
          videoBlobKey: key,
          failReason: null,
          quotaExceeded: 0,
          durationSec: actualDuration,
          // New footage enters the consistency hard gate: it is not ready
          // (and cannot be stitched) until the frame check passes.
          qaStatus: "pending",
          qaReason: "",
          qaModel: "",
          qaCheckedAt: null,
          verifyExempt: 0,
          updatedAt: now(),
        })
        .where(eq(schema.shots.id, shot.id));
      if (job && job.status === "running") {
        // Do NOT finish the job here: the job's driver runs the hard gate
        // next (frame check, automatic regeneration on failure) and only
        // completes once the shot is actually ready.
        await patchJob(ctx, job.id, { message: "原片已收片，正在抽帧硬验人物一致性（不通过会自动重生成）…" });
      }
      await touchProject(ctx, shot.projectId);
      ctx.invalidateQueries();
      return { ok: true, message: `第 ${shot.seq} 镜收片完成，接下来自动抽帧硬验人物一致性（不通过会自动重生成）。` };
    },
  }),

  executeStitch: defineAction({
    description: "推进拼接成片（非阻塞）：ffmpeg 在后台独立进程中运行，本动作只负责启动或收取结果——后台进行中时返回 ok:false 供稍后再次调用，完成后把成片收进存储并写入项目。由拼接任务或排查时调用。",
    request: z.object({ jobId: z.number() }),
    privileged: [privileged.stitchBackground, privileged.readFileChunk],
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      totalDurationSec: z.number(),
      resolution: z.string(),
      shotCount: z.number(),
    }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job || !job.projectId) throw new Error("拼接任务不存在。");
      const project = await loadProject(ctx, job.projectId);
      if (!project) throw new Error("项目不存在。");
      await reconcileShotStates(ctx, job.projectId);
      const shots = await loadShots(ctx, job.projectId);
      const missing = shots.filter((s) => !shotReady(s));
      if (shots.length === 0 || missing.length > 0) {
        const notGenerated = missing.filter((s) => s.genStatus !== "done" || !s.videoBlobKey);
        const notPassed = missing.filter((s) => s.genStatus === "done" && s.videoBlobKey);
        const parts: string[] = [];
        if (notGenerated.length > 0) parts.push(`${notGenerated.length} 镜未生成完成（第 ${notGenerated.map((s) => s.seq).join("、")} 镜）`);
        if (notPassed.length > 0) parts.push(`${notPassed.length} 镜未通过人物一致性硬验（第 ${notPassed.map((s) => s.seq).join("、")} 镜），硬验通过前不能拼接`);
        throw new Error(`无法拼接：${parts.join("；")}。`);
      }
      const outcome = await pollStitch(ctx, job, project, shots);
      ctx.invalidateQueries();
      if (outcome.state === "failed") throw new Error(outcome.error);
      if (outcome.state === "running") {
        return {
          ok: false,
          message:
            "拼接已在后台独立进程中进行（不占用这次调用、不会超时），请等 20 秒后再次调用 executeStitch 收取结果；成片写入后 getProject 的 hasFinal 会变为 true。",
          totalDurationSec: 0,
          resolution: "",
          shotCount: 0,
        };
      }
      return {
        ok: true,
        message: `拼接完成（${outcome.mode}）`,
        totalDurationSec: outcome.totalDurationSec,
        resolution: outcome.resolution,
        shotCount: outcome.shotCount,
      };
    },
  }),
} satisfies ActionsModule;

// ------------------------------------------------------- engine internals
// (Declared after the Actions map; handlers only run after module load.)

function splitScript(script: string, size = 1400): string[] {
const chunks: string[] = [];
let rest = script.trim();
while (rest.length > 0) {
if (rest.length <= size) {
chunks.push(rest);
break;
}
let cut = rest.lastIndexOf("\n", size);
if (cut < size * 0.4) cut = size;
chunks.push(rest.slice(0, cut));
rest = rest.slice(cut).trimStart();
}
return chunks.filter((c) => c.trim().length > 0);
}

function base64ToBytes(b64: string): Uint8Array {
const bin = atob(b64);
const out = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
return out;
}

/** Read a host file through the privileged chunk reader and store it as a blob. */
async function collectFileToBlob(ctx: Ctx, path: string, key: string, contentType: string): Promise<void> {
const parts: Uint8Array[] = [];
let offset = 0;
for (;;) {
const r = await ctx.executePrivileged(privileged.readFileChunk, { path, offset, length: 2_000_000});
const bytes = base64ToBytes(r.dataBase64);
if (bytes.length > 0) parts.push(bytes);
offset += bytes.length;
if (r.eof || bytes.length === 0) break;
if (offset > 2_000_000_000) throw new Error("文件过大，收片中止。");
}
const total = parts.reduce((n, p) => n + p.length, 0);
if (total === 0) throw new Error(`文件为空或不存在：${path}`);
const all = new Uint8Array(total);
let pos = 0;
for (const p of parts) {
all.set(p, pos);
pos += p.length;
}
await ctx.blobs.put(key, all, { contentType});
}

async function spawnVideoTask(ctx: Ctx, _projectId: number, shotId: number, jobId: number, attempt = 0) {
const d = db(ctx);
// Never clobber a finished shot: if its video is already saved, this job
// is complete without dispatching anything.
const existing = await d.select().from(schema.shots).where(eq(schema.shots.id, shotId));
const shotNow = existing[0];
if (shotNow && shotReady(shotNow)) {
await patchJob(ctx, jobId, { status: "done", progressDone: 1, progressTotal: 1, message: "视频生成完成，人物一致性硬验已通过"});
return;
}
if (shotNow?.videoBlobKey && shotNow.genStatus === "done") {
// Footage exists but has not passed the hard gate yet: never clobber it
// back to "generating" — the job driver verifies it as-is first and only
// regenerates after a failed verdict.
return;
}
await d
.update(schema.shots)
.set({ genStatus: "generating", failReason: null, updatedAt: now()})
.where(eq(schema.shots.id, shotId));
const message = [
`你负责为「视频生成工作流」（artifact slug：shi-pin-sheng-cheng-gong-zuo-liu）中的一个分镜生成真视频并回写结果。本任务最多生成 1 条视频。`,
`第一步：调用 artifact 动作 jobStep，参数 {"jobId": ${jobId}, "phase": "claim"}，返回的 payload 是这一镜的完整生成要求。`,
`第二步：按 payload 用你的视频生成能力生成这一镜的真视频（不要用图片动效冒充）。人物一致性是硬门禁，严格执行 payload.hardRules：按 payload.lookImageHelp 找到 payload.characters 中每一个角色的定妆图（含只在背景出现的人物）全部作为参考图传入；把每个角色 mustMatch 里的性别、外貌、发型、服装特征逐字写进生成提示词锁死；画面里绝不出现名单之外的任何人物（背景、远景、只露半边的人也不行）。开场承接 payload.prevEndState；台词由画面人物开口说出、嘴型明显同步，旁白才用画外音；必须有环境音/背景音乐；画面里不要烧字幕。收片后工作流会抽帧逐人硬验（含背景人物），对不上就作废重生成，所以务必按锚图与写死特征生成。`,
`第三步：生成成功拿到视频文件本地路径后，先调用 jobStep {"jobId": ${jobId}, "phase": "generated", "sourcePath": "<本地路径>", "durationSec": <实际时长>}，再调用 artifact 动作 saveShotVideo {"shotId": <payload.shotId>, "jobId": ${jobId}, "sourcePath": "<同一路径>"} 完成收片。`,
`如果生成失败：调用 jobStep {"jobId": ${jobId}, "phase": "fail", "error": "<具体失败原因>"}；若原因是视频生成额度用完，在参数里加 "quotaExceeded": true 且 error 中写明额度已用完。`,
`不要处理其他镜头，不要新建任何项目或测试内容。`,
].join("\n");
const res = await ctx.agent.spawnTask(message, { expectsAction: "jobStep", dedupeKey: `gen-video-${shotId}-j${jobId}-a${attempt}`});
if (!res.ok) {
await patchJob(ctx, jobId, { status: "failed", error: `派发视频生成任务失败：${res.error}`, message: "任务失败"});
await d
.update(schema.shots)
.set({ genStatus: "failed", failReason: `派发视频生成任务失败：${res.error}`, updatedAt: now()})
.where(eq(schema.shots.id, shotId));
return;
}
await patchJob(ctx, jobId, { taskId: res.taskId, message: "视频生成任务已在后台运行…"});
}

/** A single-shot video job whose shot has been silent past the stuck
 *  threshold: regenerate it in place (bounded), or give up loudly. */
async function regenerateStuckShot(
ctx: Ctx,
job: typeof schema.jobs.$inferSelect,
detail: Record<string, unknown>,
shot: ShotRow,
): Promise<void> {
const projectId = job.projectId;
if (!projectId) return;
const attempts = typeof detail.autoRespawns === "number"? detail.autoRespawns: 0;
if (attempts < MAX_AUTO_RESPAWNS) {
await patchJob(ctx, job.id, {
detail: {...detail, autoRespawns: attempts + 1},
message: `第 ${shot.seq} 镜生成长时间无回写（疑似卡住），正在自动重新生成（第 ${attempts + 1} 次）…`,
});
await spawnVideoTask(ctx, projectId, shot.id, job.id, attempts + 1);
return;
}
const d = db(ctx);
await d
.update(schema.shots)
.set({ genStatus: "failed", failReason: "生成任务多次长时间无回写，疑似后台任务已中断，已停止自动重试，请手动重试这一镜。", updatedAt: now()})
.where(eq(schema.shots.id, shot.id));
await patchJob(ctx, job.id, { status: "failed", error: "生成任务多次卡住无回写，已停止自动重试。", message: "任务失败"});
}

/**
 * The hard gate itself: sample frames from the shot's saved video and
 * vision-check EVERY person visible in them — foreground, background,
 * distant, half-visible — against the bound characters' look-anchor images
 * and hard-written features (gender, face, hair, costume). Throws on
 * infrastructure failure (no frames extractable, model error); a "fail"
 * verdict is data, not an exception.
 */
async function verifyShotConsistency(
ctx: Ctx,
projectId: number,
shot: ShotRow,
level: "full" | "light" = "full",
): Promise<{ verdict: "pass" | "fail"; reason: string; mode: string }> {
if (!shot.videoBlobKey) throw new Error(`第 ${shot.seq} 镜还没有视频文件，无法硬验。`);
const chars = await loadCharacters(ctx, projectId);
const bound = chars.filter((c) => parseIds(shot.characterIds).includes(c.id));
const framesRes = await ctx.executePrivileged(privileged.extractFrames, {
spaceDir: ctx.spaceDir,
blobKey: shot.videoBlobKey,
count: level === "full" ? 4 : 3,
});
if (framesRes.frames.length === 0) {
throw new Error(`第 ${shot.seq} 镜抽帧失败：没能从视频里抽出任何画面，无法进行人物一致性硬验，请稍后重试硬验。`);
}
const images: { dataBase64: string; mimeType: "image/jpeg" | "image/png"; caption?: string }[] = [];
framesRes.frames.forEach((f, i) => {
images.push({ dataBase64: f.dataBase64, mimeType: "image/jpeg", caption: `第 ${shot.seq} 镜成片抽帧图 ${i + 1}/${framesRes.frames.length}` });
});
const anchorNotes: string[] = [];
if (level === "light") {
anchorNotes.push("本次为轻量复核：定妆锚图未随附，只能按下方文字特征核对，核对从严。");
}
for (const c of bound) {
if (level === "light") break;
if (!c.imageBlobKey) {
anchorNotes.push(`角色「${c.name}」还没有定妆锚图，只能按文字特征核对，核对从严。`);
continue;
}
try {
const img = await ctx.executePrivileged(privileged.readBlobImage, {
spaceDir: ctx.spaceDir,
blobKey: c.imageBlobKey,
maxWidth: 384,
});
if (img.found) {
images.push({ dataBase64: img.dataBase64, mimeType: "image/jpeg", caption: `角色「${c.name}」的定妆锚图` });
} else {
anchorNotes.push(`角色「${c.name}」的定妆锚图读取失败，只能按文字特征核对，核对从严。`);
}
} catch {
anchorNotes.push(`角色「${c.name}」的定妆锚图读取失败，只能按文字特征核对，核对从严。`);
}
}
const castText = bound.length
? bound.map((c) => `- ${c.name}：性别与外貌特征「${c.appearance || "（未填）"}」；服装「${c.costume || "（未填）"}」`).join("\n")
: "（本镜没有绑定任何出场人物，应当是空镜/场景镜，画面里不应出现任何人物）";
const out = await ctx.inference.complete(
[
`你是一名极其严格的短剧人物一致性验收员。先给你这一镜成片的抽帧图（共 ${framesRes.frames.length} 张），随后是每个出场角色的定妆锚图。这是零容忍硬验：有一处对不上就判 fail。`,
`本镜：第 ${shot.seq} 镜《${shot.title}》\n画面描述：${shot.visual}\n中文提示词：${shot.promptZh}\n台词/旁白：${shot.dialogue || "（无）"}\n开场状态：${shot.startState}\n结尾状态：${shot.endState}`,
`本镜应当出现的全部人物（包括只在背景出现的人物）及写死的定妆特征：\n${castText}${anchorNotes.length ? `\n备注：${anchorNotes.join("；")}` : ""}`,
`验收规则（任一条不满足即判 fail）：\n1. 逐张抽帧图检查画面里出现的每一个人——包括背景里的人、远处的人、只露半张脸或半个身子的人，一个都不能漏查。\n2. 画面里出现的每个人都必须能在名单里找到对应角色，且性别、面孔、发型、体型与服装颜色/款式都与该角色的定妆锚图和文字特征一致。出现名单之外的任何人物（哪怕只在背景一闪而过，或性别、服装对不上任何角色），判 fail。\n3. 按画面描述本应在本镜可见的角色，若在所有抽帧图里都找不到，或找到了但性别/脸/发型/服装明显对不上，判 fail。\n4. 名单为空（空镜）时，画面里出现任何人物都判 fail。\n5. 只判人物一致性，不评演技、画质与构图；某个人看不清、无法确认是否对得上时，按对不上处理（fail）并在 issues 里写明是哪一帧、哪个人。`,
`summary 用一句话写结论；issues 逐条列出发现的问题（通过时给空数组）。`,
].join("\n\n"),
{
schema: z.object({
verdict: z.enum(["pass", "fail"]),
summary: z.string(),
issues: z.array(z.string()),
}),
images,
timeout_secs: 180,
},
);
const reason = [out.summary, ...out.issues].filter((s) => s.trim()).join("；").slice(0, 900);
return {
verdict: out.verdict,
reason: reason || (out.verdict === "pass" ? "抽帧硬验通过：出场人物（含背景人物）与定妆锚一致。" : "抽帧硬验未通过。"),
mode: level === "full" ? "Muse 视觉硬验" : "Muse 视觉硬验（轻量复核）",
};
}

type QaAdvance = "ready" | "busy" | "exhausted";

/**
 * Drive one shot's hard gate forward by one step (called from the gen /
 * verify / batch / stitch job drivers):
 * - already passed -> "ready"
 * - footage saved, not yet checked -> run the frame check now
 * - check failed, budget left -> discard the footage and regenerate
 * - check failed, budget spent -> mark the shot failed -> "exhausted"
 * - no footage yet -> "busy" (generation is someone else's step)
 */
async function advanceShotQa(
ctx: Ctx,
job: typeof schema.jobs.$inferSelect,
shot: ShotRow,
): Promise<QaAdvance> {
const projectId = shot.projectId;
const d = db(ctx);
if (shotReady(shot)) return "ready";
if (shot.genStatus !== "done" || !shot.videoBlobKey) return "busy";
if (shot.qaStatus === "failed") {
if (shot.qaAttempts < MAX_QA_ATTEMPTS) {
const attempt = shot.qaAttempts + 1;
await ctx.blobs.delete(shot.videoBlobKey).catch(() => undefined);
await d
.update(schema.shots)
.set({
videoBlobKey: null,
genStatus: "pending",
failReason: null,
qaStatus: "pending",
qaAttempts: attempt,
updatedAt: now(),
})
.where(eq(schema.shots.id, shot.id));
await patchJob(ctx, job.id, {
message: `第 ${shot.seq} 镜人物一致性硬验未通过（${shot.qaReason.slice(0, 200)}），已作废该片，正在自动重新生成（第 ${attempt} / ${MAX_QA_ATTEMPTS} 次）…`,
});
await spawnVideoTask(ctx, projectId, shot.id, job.id, attempt);
return "busy";
}
const failReason = `人物一致性硬验未通过（已自动重生成 ${MAX_QA_ATTEMPTS} 次仍未通过）：${shot.qaReason}。请在画布卡片上重新生成这一镜，硬验通过后才能拼接。`;
await d
.update(schema.shots)
.set({ genStatus: "failed", failReason, updatedAt: now() })
.where(eq(schema.shots.id, shot.id));
return "exhausted";
}
await d
.update(schema.shots)
.set({ qaStatus: "checking", updatedAt: now() })
.where(eq(schema.shots.id, shot.id));
await patchJob(ctx, job.id, { message: `正在抽帧硬验第 ${shot.seq} 镜的人物一致性（逐人比对定妆锚图，含背景人物）…` });
let res: Awaited<ReturnType<typeof verifyShotConsistency>>;
try {
res = await verifyShotConsistency(ctx, projectId, shot, "full");
} catch (e) {
// A full check that times out (many frames + anchor images) is retried
// once in light mode — fewer frames, text features only — so a slow
// vision call cannot deadlock the gate. Any other error propagates and
// fails the job with its real reason.
const msg = e instanceof Error ? e.message : String(e);
if (!/timed out|timeout/i.test(msg)) throw e;
await patchJob(ctx, job.id, { message: `第 ${shot.seq} 镜硬验完整核对超时，正在以轻量模式（3 帧 + 文字特征）复核…` });
res = await verifyShotConsistency(ctx, projectId, shot, "light");
}
await d
.update(schema.shots)
.set({
qaStatus: res.verdict === "pass" ? "passed" : "failed",
qaReason: res.reason,
qaModel: res.mode,
qaCheckedAt: now(),
updatedAt: now(),
})
.where(eq(schema.shots.id, shot.id));
await patchJob(ctx, job.id, {
message:
res.verdict === "pass"
? `第 ${shot.seq} 镜抽帧硬验通过：出场人物（含背景人物）与定妆锚一致。`
: `第 ${shot.seq} 镜抽帧硬验未通过：${res.reason.slice(0, 300)}`,
});
return res.verdict === "pass" ? "ready" : "busy";
}

type StitchOutcome =
| { state: "running"}
| { state: "failed"; error: string}
| { state: "done"; mode: string; totalDurationSec: number; resolution: string; shotCount: number};

/**
 * One non-blocking stitch step: start (or poll) the detached ffmpeg
 * background process for this job; when it reports done, collect the film
 * into blob storage, write the project row, and finish the job. Safe to
 * call repeatedly and from several drivers at once.
 */
async function pollStitch(
ctx: Ctx,
job: typeof schema.jobs.$inferSelect,
project: typeof schema.projects.$inferSelect,
shots: ShotRow[],
): Promise<StitchOutcome> {
const res = await ctx.executePrivileged(privileged.stitchBackground, {
spaceDir: ctx.spaceDir,
jobId: job.id,
aspect: project.aspect,
items: shots.map((s) => ({
videoBlobKey: s.videoBlobKey!,
subtitle: s.dialogue.trim(),
durationSec: s.durationSec,
})),
});
if (res.state === "failed") {
return { state: "failed", error: res.error?? "拼接失败，未提供具体原因。"};
}
if (res.state === "started" || res.state === "running") {
return { state: "running"};
}
const result = {
outputPath: res.outputPath?? "",
totalDurationSec: res.totalDurationSec?? 0,
resolution: res.resolution?? "",
shotCount: res.shotCount?? shots.length,
mode: res.mode?? "",
};
const key = `videos/project-${project.id}/final.mp4`;
await collectFileToBlob(ctx, result.outputPath, key, "video/mp4");
const d = db(ctx);
await d
.update(schema.projects)
.set({
finalBlobKey: key,
finalDurationSec: result.totalDurationSec,
finalResolution: result.resolution,
finalShotCount: result.shotCount,
publishConfirmed: 0,
currentStep: 6,
updatedAt: now(),
})
.where(eq(schema.projects.id, project.id));
await patchJob(ctx, job.id, {
status: "done",
progressDone: result.shotCount,
progressTotal: result.shotCount,
message: `拼接完成（${result.mode}）：共 ${result.shotCount} 镜，总时长 ${result.totalDurationSec} 秒，分辨率 ${result.resolution}`,
});
return { state: "done", mode: result.mode, totalDurationSec: result.totalDurationSec, resolution: result.resolution, shotCount: result.shotCount};
}

/** Fill only the empty description fields of one character, from the script. */
async function describeOne(ctx: Ctx, projectId: number, characterId: number): Promise<void> {
const d = db(ctx);
const chars = await loadCharacters(ctx, projectId);
const c = chars.find((x) => x.id === characterId);
if (!c) throw new Error("角色不存在。");
if (characterComplete(c)) return;
const project = await loadProject(ctx, projectId);
const script = project?.script?? "";
// Give the model the passages where this character appears, not the whole
// long script at once.
const passages: string[] = [];
let idx = script.indexOf(c.name);
while (idx >= 0 && passages.join("").length < 3000) {
passages.push(script.slice(Math.max(0, idx - 200), Math.min(script.length, idx + 500)));
idx = script.indexOf(c.name, idx + c.name.length);
if (passages.length >= 5) break;
}
const context = passages.length > 0? passages.join("\n……\n"): script.slice(0, 3000);
const out = await textComplete(
ctx,
[
`角色名：${c.name}`,
`已有定妆（不要改动，只补空缺项）：外貌「${c.appearance}」服装「${c.costume}」性格「${c.personality}」声音「${c.voice}」`,
`脚本中与该角色相关的片段：\n${context}`,
`请根据这个角色在脚本中的身份、出场、台词和与其他人物的关系，为它补齐四项定妆：外貌（年龄、长相、发型、体型，足够具体到能画出定妆图）、服装（一套从头到尾不变的定妆服装，写清颜色与款式）、性格、声音（音色与说话风格）。已有内容的字段请原样返回，不要改写。`,
].join("\n\n"),
z.object({
appearance: z.string(),
costume: z.string(),
personality: z.string(),
voice: z.string(),
}),
"你是一位短剧选角与定妆师，输出要具体、可视化、同一角色全片一致。",
);
const values: Record<string, unknown> = { updatedAt: now()};
if (!c.appearance.trim() && out.appearance.trim()) values.appearance = out.appearance.trim();
if (!c.costume.trim() && out.costume.trim()) values.costume = out.costume.trim();
if (!c.personality.trim() && out.personality.trim()) values.personality = out.personality.trim();
if (!c.voice.trim() && out.voice.trim()) values.voice = out.voice.trim();
await d.update(schema.characters).set(values).where(eq(schema.characters.id, c.id));
}

/** Generate (or regenerate) one character's look image; locks on success. */
async function lookOne(ctx: Ctx, projectId: number, characterId: number): Promise<void> {
const d = db(ctx);
let chars = await loadCharacters(ctx, projectId);
let c = chars.find((x) => x.id === characterId);
if (!c) throw new Error("角色不存在。");
if (!characterComplete(c)) {
await describeOne(ctx, projectId, characterId);
chars = await loadCharacters(ctx, projectId);
c = chars.find((x) => x.id === characterId)!;
}
if (!characterComplete(c)) {
await d
.update(schema.characters)
.set({ imageStatus: "failed", imageFailReason: "角色描述仍不完整，无法生成定妆图，请先补齐外貌与服装描述。", updatedAt: now()})
.where(eq(schema.characters.id, c.id));
return;
}
await d
.update(schema.characters)
.set({ imageStatus: "generating", imageFailReason: null, updatedAt: now()})
.where(eq(schema.characters.id, c.id));
const project = await loadProject(ctx, projectId);
const prompt = [
`角色定妆参考图（角色圣经用，单人肖像，全身或大半身，纯色干净背景，正面站姿，方便后续视频生成保持同一张脸与同一套服装）`,
`角色：${c.name}。外貌：${c.appearance}。服装：${c.costume}。性格气质：${c.personality}。`,
`作品类型：${project?.videoType?? "短剧"}，整体基调：${project?.tone || "写实"}。画面风格与作品类型一致，人物长相清晰稳定、特征鲜明。`,
].join("\n");
try {
const media = await ctx.tool.generate_media(prompt, {
orientation: project?.aspect === "16:9"? "landscape": "portrait",
});
// New image replaces the old only after it exists: set the key now.
await d
.update(schema.characters)
.set({ imageBlobKey: media.blobKey, imageStatus: "idle", imageFailReason: null, locked: 1, updatedAt: now()})
.where(eq(schema.characters.id, c.id));
} catch (e) {
const msg = e instanceof Error? e.message: String(e);
await d
.update(schema.characters)
.set({ imageStatus: "failed", imageFailReason: `定妆图生成失败：${msg.slice(0, 300)}`, updatedAt: now()})
.where(eq(schema.characters.id, c.id));
}
}

async function checkOnePair(
ctx: Ctx,
projectId: number,
row: typeof schema.continuity.$inferSelect,
): Promise<void> {
const d = db(ctx);
const shots = await loadShots(ctx, projectId);
const from = shots.find((s) => s.id === row.fromShotId);
const to = shots.find((s) => s.id === row.toShotId);
if (!from ||!to) return;
const chars = await loadCharacters(ctx, projectId);
const describeShot = (s: typeof from) => {
const names = chars.filter((c) => parseIds(s.characterIds).includes(c.id)).map((c) => c.name).join("、") || "无（空镜/场景镜）";
return `镜号 ${s.seq}《${s.title}》时长 ${s.durationSec} 秒\n画面：${s.visual}\n台词/旁白：${s.dialogue || "（无）"}\n出场人物：${names}\n中文提示词：${s.promptZh}\n开场状态：${s.startState}\n结尾状态：${s.endState}`;
};
const out = await textComplete(
ctx,
[
`你是短剧场记，请核对下面相邻两镜的连续性：时间、场景、服装、道具、情绪、人物位置，以及上一镜结尾状态与下一镜开场状态是否承接。`,
`\n${describeShot(from)}`,
`\n${describeShot(to)}`,
`给出结论：ok=衔接成立，jump=小跳跃（有小不一致但不影响理解），broken=衔接断裂（状态接不上、人物/服装/场景明显对不上）。reason 写明具体原因，suggestion 给可直接执行的修改建议（ok 时可写“无需修改”）。全程只依据中文提示词与中文描述判断，不需要也不得要求英文提示词。`,
].join("\n\n"),
z.object({
verdict: z.enum(["ok", "jump", "broken"]),
reason: z.string(),
suggestion: z.string(),
}),
"你是一位严谨的短剧场记，只输出核对结论。",
);
await d
.update(schema.continuity)
.set({
verdict: out.verdict,
reason: out.reason,
suggestion: out.suggestion,
modelLabel: await modelLabel(ctx),
checkedAt: now(),
updatedAt: now(),
})
.where(eq(schema.continuity.id, row.id));
}

async function stepJob(ctx: Ctx, job: typeof schema.jobs.$inferSelect): Promise<void> {
const projectId = job.projectId;
if (!projectId) throw new Error("任务缺少项目。");
const project = await loadProject(ctx, projectId);
if (!project) throw new Error("项目不存在。");
const detail = jobDetail(job);
const d = db(ctx);
if (job.kind === "gen_video" || job.kind === "gen_all_videos" || job.kind === "verify_shot" || job.kind === "stitch") {
await reconcileShotStates(ctx, projectId);
}
const label = await modelLabel(ctx);
const batch = label === "Muse"? 3: 4;

switch (job.kind) {
case "script": {
const out = await textComplete(
ctx,
[
`请根据下面的选题与设定，写一份完整可拍的视频脚本。`,
`题材/主题：${project.topic || project.title}\n视频类型：${project.videoType}\n画幅：${project.aspect}\n目标时长：${project.targetDuration}\n目标受众：${project.audience || "不限"}\n发布平台：${project.platform}\n整体基调：${project.tone || "不限"}`,
`脚本要求：有明确的开端、发展、高潮与结尾；逐场写清场景、画面内容、人物台词（注明说话人）与旁白；台词口语化、符合人物身份；总时长与目标时长大致匹配。suggestedTitle 给一个贴切的片名。`,
].join("\n\n"),
z.object({ script: z.string().min(1), suggestedTitle: z.string()}),
"你是一位经验丰富的短视频编剧，擅长短剧、漫剧、口播与产品种草等各种类型。",
);
await d
.update(schema.projects)
.set({
script: out.script,
scriptVersion: project.scriptVersion + 1,
title: project.title === "未命名项目" && out.suggestedTitle.trim()? out.suggestedTitle.trim(): project.title,
currentStep: Math.max(project.currentStep, 2),
updatedAt: now(),
})
.where(eq(schema.projects.id, projectId));
await patchJob(ctx, job.id, {
status: "done",
progressDone: 1,
progressTotal: 1,
message: "脚本已生成并保存（重新生成前，上一版脚本已保留在任务记录中，可对比恢复）。",
detail: {...detail, generatedLength: out.script.length},
});
return;
}

case "storyboard": {
const chunks = splitScript(project.script);
const chunkIndex = typeof detail.chunkIndex === "number"? detail.chunkIndex: 0;
if (chunkIndex >= chunks.length) {
await rebuildContinuity(ctx, projectId);
await patchJob(ctx, job.id, { status: "done", message: "分镜已全部拆解并排到画布上。"});
return;
}
const out = await textComplete(
ctx,
[
`请把下面这段脚本拆成一个个分镜（这是整份脚本的第 ${chunkIndex + 1} / ${chunks.length} 段；若不是第一段，第一镜的开场状态要承接前文结尾）。`,
`作品：${project.videoType}，画幅 ${project.aspect}，基调 ${project.tone || "不限"}。`,
`脚本片段：\n${chunks[chunkIndex]}`,
`每个分镜给出：title 标题；durationSec 时长（秒，3–15）；visual 画面描述；dialogue 台词/旁白（台词要注明说话人，纯旁白注明“旁白”）；promptZh 中文视频生成提示词（只写中文，包含场景、人物动作、镜头运动、光线氛围，并写明人物开口说话做口型同步或旁白画外音）；startState 本镜开场状态（人物位置、服装、道具、情绪）；endState 本镜结尾状态；characters 本镜出场人物名字数组（没有人物就给空数组）。相邻分镜的状态要首尾承接。`,
].join("\n\n"),
z.object({
shots: z.array(
z.object({
title: z.string(),
durationSec: z.number().min(1).max(30),
visual: z.string(),
dialogue: z.string(),
promptZh: z.string(),
startState: z.string(),
endState: z.string(),
characters: z.array(z.string()),
}),
),
}),
"你是一位短剧分镜师，拆镜细致、状态承接严谨。",
);
const before = await loadShots(ctx, projectId);
for (let i = 0; i < out.shots.length; i++) {
const s = out.shots[i]!;
const totalIndex = before.length + i;
const ids = await autoBindShot(ctx, projectId, s, s.characters);
await d.insert(schema.shots).values({
projectId,
seq: totalIndex + 1,
title: s.title || `第 ${totalIndex + 1} 镜`,
durationSec: s.durationSec,
visual: s.visual,
dialogue: s.dialogue,
promptZh: s.promptZh,
startState: s.startState,
endState: s.endState,
characterIds: JSON.stringify(ids),
posX: 24 + (totalIndex % 3) * 400,
posY: 24 + Math.floor(totalIndex / 3) * 330,
});
}
const nextIndex = chunkIndex + 1;
if (nextIndex >= chunks.length) {
await rebuildContinuity(ctx, projectId);
await touchProject(ctx, projectId, { currentStep: Math.max(project.currentStep, 3)});
await patchJob(ctx, job.id, {
status: "done",
progressDone: chunks.length,
progressTotal: chunks.length,
message: `分镜拆解完成：共 ${before.length + out.shots.length} 镜，已排到画布并按顺序连线。`,
detail: {...detail, chunkIndex: nextIndex},
});
} else {
await patchJob(ctx, job.id, {
progressDone: nextIndex,
progressTotal: chunks.length,
message: `正在拆分镜：已完成第 ${nextIndex} / ${chunks.length} 段…`,
detail: {...detail, chunkIndex: nextIndex},
});
}
return;
}

case "extract_characters": {
const phase = typeof detail.phase === "string"? detail.phase: "extract";
if (phase === "extract") {
const chunks = splitScript(project.script);
const chunkIndex = typeof detail.chunkIndex === "number"? detail.chunkIndex: 0;
if (chunkIndex >= chunks.length) {
const chars = await loadCharacters(ctx, projectId);
const needDesc = chars.filter((c) =>!characterComplete(c)).length;
const needLook = chars.filter((c) =>!c.imageBlobKey).length;
await patchJob(ctx, job.id, {
progressDone: 0,
progressTotal: needDesc,
message: `角色提取完成（共 ${chars.length} 个角色），正在逐个补齐定妆描述…`,
detail: {...detail, phase: "describe"},
});
if (needDesc === 0 && needLook === 0) {
await patchJob(ctx, job.id, { status: "done", message: `角色已全部就绪（共 ${chars.length} 个），描述与定妆图完整。`});
}
return;
}
const chars = await loadCharacters(ctx, projectId);
const known = chars.map((c) => c.name);
const out = await textComplete(
ctx,
[
`从下面这段脚本中，找出出场人物里还没有出现在已知名单中的新角色，最多返回 2 个（按出场先后）。`,
`已知名单（不要重复返回）：${known.length? known.join("、"): "（无）"}`,
`规则：群像算一个角色（例如“小猴子们”），不要把群像拆成带括号的分组名（不要返回“小猴子们（含小猴子甲）”这类名字）；只有脚本里明确单独出场、有独立台词或行动的人物才单独算一个角色；纯粹被提及、没有出场的人物不要返回。`,
`脚本片段：\n${chunks[chunkIndex]}`,
].join("\n\n"),
z.object({ characters: z.array(z.object({ name: z.string()})).max(2)}),
"你是一位短剧选角助理，只负责认出新出场人物。",
);
let added = 0;
for (const item of out.characters) {
const name = item.name.trim();
if (!name) continue;
const fresh = await loadCharacters(ctx, projectId);
if (fresh.some((c) => c.name === name || baseName(c.name) === baseName(name))) continue;
if (name.includes("（") && fresh.some((c) => baseName(c.name) === baseName(name))) continue;
await d.insert(schema.characters).values({ projectId, name, tag: `@${name}`});
added++;
}
const total = (await loadCharacters(ctx, projectId)).length;
await patchJob(ctx, job.id, {
progressDone: chunkIndex + 1,
progressTotal: chunks.length,
message: `正在分段提取角色：已扫描 ${chunkIndex + 1} / ${chunks.length} 段，角色棚现有 ${total} 个角色${added? `（本段新增 ${added} 个）`: ""}…`,
detail: {...detail, chunkIndex: chunkIndex + 1},
});
return;
}
if (phase === "describe") {
const chars = await loadCharacters(ctx, projectId);
const target = chars.find((c) =>!characterComplete(c));
if (!target) {
const needLook = chars.filter((c) =>!c.imageBlobKey).length;
await patchJob(ctx, job.id, {
progressDone: 0,
progressTotal: needLook,
message: "定妆描述已补齐，正在并发生成定妆图（一批 3 个）…",
detail: {...detail, phase: "look"},
});
if (needLook === 0) {
await patchJob(ctx, job.id, { status: "done", message: `提取链路完成：${chars.length} 个角色的描述与定妆图都已就绪并锁定。`});
}
return;
}
await describeOne(ctx, projectId, target.id);
const after = await loadCharacters(ctx, projectId);
const remaining = after.filter((c) =>!characterComplete(c)).length;
await patchJob(ctx, job.id, {
progressDone: after.length - remaining,
progressTotal: after.length,
message: `已补齐 ${target.name} 的定妆描述，还剩 ${remaining} 个待补…`,
});
return;
}
// phase look: up to 3 concurrent per step
const chars = await loadCharacters(ctx, projectId);
const targets = chars.filter((c) =>!c.imageBlobKey && c.imageStatus!== "generating").slice(0, 3);
if (targets.length === 0) {
const stillMissing = chars.filter((c) =>!c.imageBlobKey).length;
await patchJob(ctx, job.id, {
status: "done",
progressDone: chars.length - stillMissing,
progressTotal: chars.length,
message:
stillMissing === 0
? `提取链路完成：${chars.length} 个角色的描述与定妆图都已就绪并锁定。`
: `提取链路结束：${stillMissing} 个角色的定妆图生成失败，原因已写在对应角色卡上，可单独重试。`,
});
return;
}
await Promise.all(targets.map((c) => lookOne(ctx, projectId, c.id)));
const after = await loadCharacters(ctx, projectId);
const doneCount = after.filter((c) => c.imageBlobKey).length;
await patchJob(ctx, job.id, {
progressDone: doneCount,
progressTotal: after.length,
message: `定妆图已生成 ${doneCount} / ${after.length} 张…`,
});
return;
}

case "describe_character": {
const characterId = typeof detail.characterId === "number"? detail.characterId: 0;
await describeOne(ctx, projectId, characterId);
await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "角色描述已生成并保存（只补了空缺项）。"});
return;
}

case "describe_all": {
const chars = await loadCharacters(ctx, projectId);
const target = chars.find((c) =>!characterComplete(c));
if (!target) {
await patchJob(ctx, job.id, { status: "done", message: "全部角色描述已补齐。"});
return;
}
await describeOne(ctx, projectId, target.id);
const after = await loadCharacters(ctx, projectId);
const remaining = after.filter((c) =>!characterComplete(c)).length;
await patchJob(ctx, job.id, {
progressDone: after.length - remaining,
progressTotal: after.length,
message: `已补齐 ${target.name} 的描述，还剩 ${remaining} 个待补…`,
});
if (remaining === 0) {
await patchJob(ctx, job.id, { status: "done", message: "全部角色描述已补齐。"});
}
return;
}

case "look_image": {
const characterId = typeof detail.characterId === "number"? detail.characterId: 0;
await lookOne(ctx, projectId, characterId);
const chars = await loadCharacters(ctx, projectId);
const c = chars.find((x) => x.id === characterId);
await patchJob(ctx, job.id, {
status: "done",
progressDone: 1,
progressTotal: 1,
message: c?.imageBlobKey? `${c.name} 的定妆图已生成并锁定。`: `${c?.name?? "角色"} 的定妆图未生成成功，原因见角色卡。`,
});
return;
}

case "look_all": {
const chars = await loadCharacters(ctx, projectId);
const targets = chars.filter((c) =>!c.imageBlobKey && c.imageStatus!== "generating").slice(0, 3);
if (targets.length === 0) {
const missing = chars.filter((c) =>!c.imageBlobKey).length;
await patchJob(ctx, job.id, {
status: "done",
message: missing === 0? "全部定妆图已生成并锁定。": `定妆图生成结束：${missing} 个失败，原因见对应角色卡，可单独重试。`,
});
return;
}
await Promise.all(targets.map((c) => lookOne(ctx, projectId, c.id)));
const after = await loadCharacters(ctx, projectId);
const doneCount = after.filter((c) => c.imageBlobKey).length;
const totalTargets = typeof job.progressTotal === "number" && job.progressTotal > 0? job.progressTotal: after.length;
await patchJob(ctx, job.id, {
progressDone: Math.min(doneCount, totalTargets),
progressTotal: totalTargets,
message: `定妆图已完成 ${doneCount} 张（本批并行 3 个）…`,
});
if (after.every((c) => c.imageBlobKey || c.imageStatus === "failed")) {
const missing = after.filter((c) =>!c.imageBlobKey).length;
await patchJob(ctx, job.id, {
status: "done",
message: missing === 0? "全部定妆图已生成并锁定。": `定妆图生成结束：${missing} 个失败，原因见对应角色卡，可单独重试。`,
});
}
return;
}

case "check_continuity": {
const rows = (await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId)).orderBy(asc(schema.continuity.id)))
.filter((r) =>!r.verdict);
const all = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
if (rows.length === 0) {
const bad = all.filter((r) => r.verdict === "jump" || r.verdict === "broken").length;
await patchJob(ctx, job.id, {
status: "done",
progressDone: all.length,
progressTotal: all.length,
message: `连续性检查完成（模型：${label}，并发 ${batch} 路）：共 ${all.length} 对，${bad === 0? "全部衔接成立": `有 ${bad} 对存在小跳跃或断裂，可一键修复`}。`,
});
return;
}
const batchRows = rows.slice(0, batch);
await Promise.all(batchRows.map((r) => checkOnePair(ctx, projectId, r)));
const after = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
const doneCount = after.filter((r) => r.verdict).length;
await patchJob(ctx, job.id, {
progressDone: doneCount,
progressTotal: after.length,
message: `连续性检查进行中（模型：${label}，并发 ${batch} 路）：已完成 ${doneCount} / 共 ${after.length} 对…`,
});
if (doneCount >= after.length) {
const bad = after.filter((r) => r.verdict === "jump" || r.verdict === "broken").length;
await patchJob(ctx, job.id, {
status: "done",
message: `连续性检查完成（模型：${label}）：共 ${after.length} 对，${bad === 0? "全部衔接成立": `有 ${bad} 对存在小跳跃或断裂，可一键修复`}。`,
});
}
return;
}

case "fix_continuity": {
const phase = typeof detail.phase === "string"? detail.phase: "fix";
const rows = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId)).orderBy(asc(schema.continuity.id));
if (phase === "fix") {
const bad = rows.filter((r) => r.verdict === "jump" || r.verdict === "broken");
if (bad.length === 0) {
// Move to full re-check: clear all verdicts and re-verify.
for (const r of rows) {
await d
.update(schema.continuity)
.set({ verdict: null, reason: "", suggestion: "", checkedAt: null, updatedAt: now()})
.where(eq(schema.continuity.id, r.id));
}
await patchJob(ctx, job.id, {
progressDone: 0,
progressTotal: rows.length,
message: "修复已全部写回，正在并发复查整条链…",
detail: {...detail, phase: "recheck"},
});
return;
}
// Pick a batch of pairs that do not share a shot (parallel-safe).
const used = new Set<number>();
const batchPairs: typeof bad = [];
for (const r of bad) {
if (used.has(r.fromShotId) || used.has(r.toShotId)) continue;
batchPairs.push(r);
used.add(r.fromShotId);
used.add(r.toShotId);
if (batchPairs.length >= batch) break;
}
const shots = await loadShots(ctx, projectId);
const chars = await loadCharacters(ctx, projectId);
await Promise.all(
batchPairs.map(async (r) => {
const from = shots.find((s) => s.id === r.fromShotId);
const to = shots.find((s) => s.id === r.toShotId);
if (!from ||!to) return;
const names = chars.filter((c) => parseIds(to.characterIds).includes(c.id)).map((c) => `${c.name}（外貌：${c.appearance}；服装：${c.costume}）`).join("；");
const out = await textComplete(
ctx,
[
`相邻两镜存在连续性问题（${r.verdict === "broken"? "衔接断裂": "小跳跃"}）：${r.reason}`,
`场记建议：${r.suggestion}`,
`画面：${from.visual}\n中文提示词：${from.promptZh}\n结尾状态：${from.endState}`,
`画面：${to.visual}\n台词/旁白：${to.dialogue || "（无）"}\n中文提示词：${to.promptZh}\n开场状态：${to.startState}\n结尾状态：${to.endState}\n出场角色定妆：${names || "无"}`,
`请直接改好并返回：fromEndState 上一镜结尾状态（必要时微调，使其能自然接到下一镜）、toStartState 下一镜开场状态（必须承接上一镜结尾）、toVisual 下一镜画面描述、toPromptZh 下一镜中文提示词（只写中文）。不要改动剧情走向与台词，只修衔接。`,
].join("\n\n"),
z.object({
fromEndState: z.string(),
toStartState: z.string(),
toVisual: z.string(),
toPromptZh: z.string(),
}),
"你是一位短剧场记兼分镜师，专修相邻镜头衔接。",
);
await d.update(schema.shots).set({ endState: out.fromEndState, updatedAt: now()}).where(eq(schema.shots.id, from.id));
await d
.update(schema.shots)
.set({ startState: out.toStartState, visual: out.toVisual, promptZh: out.toPromptZh, updatedAt: now()})
.where(eq(schema.shots.id, to.id));
}),
);
// The fixed pairs (and their neighbours) need re-verification.
const touched = [...new Set(batchPairs.flatMap((r) => [r.fromShotId, r.toShotId]))];
await invalidatePairs(ctx, projectId, touched);
const after = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
const remainingBad = after.filter((r) => r.verdict === "jump" || r.verdict === "broken").length;
await patchJob(ctx, job.id, {
message: `已修复 ${batchPairs.length} 处衔接，还剩 ${remainingBad} 处待修…`,
});
return;
}
// recheck phase: concurrent verification of the whole chain
const unchecked = rows.filter((r) =>!r.verdict);
if (unchecked.length === 0) {
const bad = rows.filter((r) => r.verdict === "jump" || r.verdict === "broken");
const shotsNow = await loadShots(ctx, projectId);
const seqOf = new Map(shotsNow.map((s) => [s.id, s.seq]));
await patchJob(ctx, job.id, {
status: "done",
progressDone: rows.length,
progressTotal: rows.length,
message:
bad.length === 0
? "一键修复完成，复查通过：全部相邻分镜衔接成立。"
: `修复与复查完成，但仍有 ${bad.length} 对未通过：第 ${bad.map((r) => `${seqOf.get(r.fromShotId)?? "?"}→${seqOf.get(r.toShotId)?? "?"} 镜`).join("、")}，可再次点击一键修复。`,
});
return;
}
const batchRows = unchecked.slice(0, batch);
await Promise.all(batchRows.map((r) => checkOnePair(ctx, projectId, r)));
const after = await d.select().from(schema.continuity).where(eq(schema.continuity.projectId, projectId));
const doneCount = after.filter((r) => r.verdict).length;
await patchJob(ctx, job.id, {
progressDone: doneCount,
progressTotal: after.length,
message: `正在并发复查：已完成 ${doneCount} / 共 ${after.length} 对…`,
});
return;
}

case "publish_copy": {
const shots = await loadShots(ctx, projectId);
const out = await textComplete(
ctx,
[
`为下面这条视频整理发布用的标题和文案。`,
`平台：${project.platform}\n类型：${project.videoType}\n题材/主题：${project.topic || project.title}\n基调：${project.tone || "不限"}\n目标受众：${project.audience || "不限"}`,
`分镜梗概：${shots.map((s) => `${s.seq}. ${s.title}`).join("；") || "（无分镜信息）"}`,
`title：一句抓人的发布标题（不超过 30 字，可带 1–2 个话题标签）。copy：发布文案（2–4 句，口语化，结尾带 3–5 个相关话题标签）。`,
].join("\n\n"),
z.object({ title: z.string(), copy: z.string()}),
"你是一位短视频运营，擅长各平台的标题与文案。",
);
await d
.update(schema.projects)
.set({ publishTitle: out.title, publishCopy: out.copy, publishConfirmed: 0, updatedAt: now()})
.where(eq(schema.projects.id, projectId));
await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "发布标题与文案已整理好，请在第六步确认后使用（不会自动发布）。"});
return;
}

case "gen_all_videos": {
const shotIds = Array.isArray(detail.shotIds)? detail.shotIds.filter((x): x is number => typeof x === "number"): [];
let shots = await loadShots(ctx, projectId);
let targets = shots.filter((s) => shotIds.includes(s.id));
// Self-heal shots whose background task went silent: retire their orphan
// jobs and reset them to pending so they are regenerated below instead of
// blocking this batch forever.
const respawns = (detail.shotRespawns && typeof detail.shotRespawns === "object"? detail.shotRespawns: {}) as Record<string, number>;
let healed = false;
let respawnIncremented = false;
for (const s of targets) {
if (!isStuckShot(s)) continue;
healed = true;
await failActiveVideoJobs(ctx, projectId, s.id, "生成长时间无回写，判定卡住，已由批量生成自动重新生成接管。");
const n = respawns[String(s.id)]?? 0;
if (n < MAX_AUTO_RESPAWNS) {
respawns[String(s.id)] = n + 1;
respawnIncremented = true;
await d.update(schema.shots).set({ genStatus: "pending", failReason: null, updatedAt: now()}).where(eq(schema.shots.id, s.id));
} else {
await d.update(schema.shots).set({ genStatus: "failed", failReason: "生成任务多次长时间无回写，疑似后台任务已中断，已停止自动重试，请手动重试这一镜。", updatedAt: now()}).where(eq(schema.shots.id, s.id));
}
}
if (healed) {
if (respawnIncremented) {
await patchJob(ctx, job.id, { detail: {...detail, shotRespawns: respawns}});
}
shots = await loadShots(ctx, projectId);
targets = shots.filter((s) => shotIds.includes(s.id));
}
const inFlight = targets.filter((s) => s.genStatus === "generating" || s.genStatus === "processing").length;
const pending = targets.filter((s) => s.genStatus === "pending" || (s.genStatus === "failed" && s.quotaExceeded!== 1 && !qaExhausted(s)));
const toSpawn = pending.slice(0, Math.max(0, 6 - inFlight));
for (const shot of toSpawn) {
const childId = await createJob(ctx, projectId, "gen_video", { shotId: shot.id, parentJobId: job.id}, `正在生成第 ${shot.seq} 镜的真视频…`, 1);
await spawnVideoTask(ctx, projectId, shot.id, childId);
}
// Shots whose footage is saved but which still owe the hard gate get a
// verification child (no new footage unless the gate itself fails them);
// at most 4 gate checks run at once.
const gateShots = targets.filter((s) => s.genStatus === "done" && !shotReady(s));
let gateActive = 0;
const gateQueue: ShotRow[] = [];
for (const s of gateShots) {
if (await hasActiveShotJob(ctx, projectId, s.id)) gateActive++;
else gateQueue.push(s);
}
let gateSpawned = 0;
for (const s of gateQueue) {
if (gateActive + gateSpawned >= 4) break;
await createJob(ctx, projectId, "verify_shot", { shotId: s.id, parentJobId: job.id}, `正在抽帧硬验第 ${s.seq} 镜的人物一致性…`, 1);
gateSpawned++;
}
const readyCount = targets.filter((s) => shotReady(s)).length;
const doneCount = readyCount;
const failedCount = targets.filter((s) => s.genStatus === "failed").length;
const quotaCount = targets.filter((s) => s.quotaExceeded === 1).length;
const gatePending = gateShots.length;
await patchJob(ctx, job.id, {
progressDone: doneCount + failedCount,
progressTotal: targets.length,
message: `并发生成中：已就绪 ${doneCount} / ${targets.length} 镜${gatePending? `，${gatePending} 镜待硬验/硬验中`: ""}${failedCount? `，失败 ${failedCount} 镜`: ""}${quotaCount? `（其中 ${quotaCount} 镜因额度用完失败）`: ""}…`,
});
if (doneCount + failedCount >= targets.length && inFlight === 0 && toSpawn.length === 0 && gateActive === 0 && gateSpawned === 0) {
await patchJob(ctx, job.id, {
status: "done",
message:
failedCount === 0
? `全部 ${targets.length} 镜视频已生成并通过人物一致性硬验，可以拼接成片。`
: `批量生成结束：${doneCount} 镜就绪，${failedCount} 镜失败（原因在对应卡片上）${quotaCount? `，其中 ${quotaCount} 镜是额度用完，请等额度恢复后再重试失败镜头`: "，可重试失败镜头"}。`,
});
}
return;
}

case "gen_video": {
const shotId = typeof detail.shotId === "number"? detail.shotId: 0;
const shots = await loadShots(ctx, projectId);
const shot = shots.find((s) => s.id === shotId);
if (!shot) {
await patchJob(ctx, job.id, { status: "failed", error: "分镜不存在，任务终止。", message: "任务失败"});
} else if (shotReady(shot)) {
await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "视频生成完成，人物一致性硬验已通过"});
} else if (shot.genStatus === "done") {
// Footage is saved: drive the consistency hard gate (frame check now;
// automatic regeneration when the check fails). The job completes only
// once the shot is actually ready.
const r = await advanceShotQa(ctx, job, shot);
if (r === "exhausted") {
const fresh = (await loadShots(ctx, projectId)).find((s) => s.id === shotId);
await patchJob(ctx, job.id, { status: "failed", error: fresh?.failReason?? "人物一致性硬验多次未通过。", message: "任务失败"});
}
} else if (shot.genStatus === "failed") {
await patchJob(ctx, job.id, { status: "failed", error: shot.failReason?? "视频生成失败", message: "任务失败"});
} else if (shot.genStatus === "processing" && typeof detail.sourcePath === "string" && detail.sourcePath) {
// The clip was generated but never collected (the background task went
// silent mid-collection): retry the collection from the file it left
// behind instead of regenerating the video.
try {
await collectFileToBlob(ctx, detail.sourcePath, `videos/project-${projectId}/shot-${shot.id}-${job.id}.mp4`, "video/mp4");
await d.update(schema.shots).set({ genStatus: "done", videoBlobKey: `videos/project-${projectId}/shot-${shot.id}-${job.id}.mp4`, failReason: null, quotaExceeded: 0, qaStatus: "pending", qaReason: "", qaModel: "", qaCheckedAt: null, verifyExempt: 0, updatedAt: now()}).where(eq(schema.shots.id, shot.id));
await patchJob(ctx, job.id, { message: "已自动补收之前生成好的原片，正在抽帧硬验人物一致性…"});
await touchProject(ctx, projectId);
} catch {
// Collection failed too; fall through to the stuck-shot handling.
if (isStuckShot(shot)) {
await regenerateStuckShot(ctx, job, detail, shot);
}
}
} else if (isStuckShot(shot)) {
await regenerateStuckShot(ctx, job, detail, shot);
}
return;
}

case "verify_shot": {
const shotId = typeof detail.shotId === "number"? detail.shotId: 0;
const shots = await loadShots(ctx, projectId);
const shot = shots.find((s) => s.id === shotId);
if (!shot) {
await patchJob(ctx, job.id, { status: "failed", error: "分镜不存在，任务终止。", message: "任务失败"});
return;
}
const r = await advanceShotQa(ctx, job, shot);
if (r === "ready") {
await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: `第 ${shot.seq} 镜人物一致性硬验通过。`});
} else if (r === "exhausted") {
const fresh = (await loadShots(ctx, projectId)).find((s) => s.id === shotId);
await patchJob(ctx, job.id, { status: "failed", error: fresh?.failReason?? "人物一致性硬验多次未通过。", message: "任务失败"});
} else if (shot.genStatus === "failed") {
// A regeneration the gate itself spawned failed in the background.
await patchJob(ctx, job.id, { status: "failed", error: shot.failReason?? "重新生成失败", message: "任务失败"});
}
// Otherwise the gate is mid-check or a regeneration is in flight; the
// next poll step continues from the shot's fresh state.
return;
}

case "stitch": {
if (project.finalBlobKey && project.finalBlobKey!== String(detail.finalKeyBefore?? "")) {
await patchJob(ctx, job.id, { status: "done", progressDone: 1, progressTotal: 1, message: "拼接成片完成"});
return;
}
// Not all shots were ready when this job started: generate whatever is
// missing or stuck, verify whatever is saved but has not passed the
// consistency hard gate, and run the background stitch only once every
// shot is ready — the gate is never skipped to reach the stitch.
const shotsNow = await loadShots(ctx, projectId);
const missing = shotsNow.filter((s) => !shotReady(s));
if (missing.length === 0) {
const outcome = await pollStitch(ctx, job, project, shotsNow);
if (outcome.state === "failed") {
await patchJob(ctx, job.id, { status: "failed", error: outcome.error, message: "任务失败"});
return;
}
if (outcome.state === "running") {
const startedAt = typeof detail.stitchStartedAt === "number"? detail.stitchStartedAt: Date.now();
if (Date.now() - startedAt > STITCH_STUCK_MS) {
await patchJob(ctx, job.id, { status: "failed", error: "拼接后台进程长时间未完成，判定卡住，请重试拼接（已生成的分镜不会丢失）。", message: "任务失败"});
return;
}
await patchJob(ctx, job.id, {
progressDone: shotsNow.length,
progressTotal: shotsNow.length,
message: `全部镜头已就绪，正在后台拼接成片（保留原声、烧录字幕），已等待 ${Math.max(0, Math.round((Date.now() - startedAt) / 1000))} 秒…`,
detail: {...detail, stitchStartedAt: startedAt},
});
}
return;
}
const quotaShot = missing.find((s) => s.quotaExceeded === 1);
if (quotaShot) {
await patchJob(ctx, job.id, { status: "failed", error: `第 ${quotaShot.seq} 镜因视频生成额度用完未能生成，等额度恢复后重试这一镜，再重新拼接。`, message: "任务失败"});
return;
}
const gateBlocked = missing.find((s) => qaExhausted(s));
if (gateBlocked) {
await patchJob(ctx, job.id, { status: "failed", error: `第 ${gateBlocked.seq} 镜人物一致性硬验多次未通过（${gateBlocked.qaReason.slice(0, 200)}），拼接被门禁拦下。请到画布上重新生成这一镜，硬验通过后再重新拼接。`, message: "任务失败"});
return;
}
const genAttempts = (detail.genAttempts && typeof detail.genAttempts === "object"? detail.genAttempts: {}) as Record<string, number>;
let genAttemptsChanged = false;
let gateActive = 0;
let gateSpawned = 0;
for (const s of missing) {
if (s.genStatus === "done" && s.videoBlobKey) {
// Saved footage that has not passed the gate: verify it as-is (the
// gate driver itself regenerates only after a failed verdict).
if (await hasActiveShotJob(ctx, projectId, s.id)) {
gateActive++;
continue;
}
if (gateActive + gateSpawned < 4) {
await createJob(ctx, projectId, "verify_shot", { shotId: s.id, parentJobId: job.id}, `正在抽帧硬验第 ${s.seq} 镜的人物一致性…`, 1);
gateSpawned++;
}
continue;
}
if (s.genStatus === "generating" || s.genStatus === "processing") {
if (!isStuckShot(s)) continue;
await failActiveVideoJobs(ctx, projectId, s.id, "生成长时间无回写，判定卡住，已由拼接流程自动重新生成接管。");
}
if (s.genStatus === "failed" && s.qaStatus === "failed") {
// A gate-driven regeneration is already in flight or queued under its
// own job; the stitch waits for it instead of stacking another one.
if (await hasActiveShotJob(ctx, projectId, s.id)) continue;
}
const n = genAttempts[String(s.id)]?? 0;
if (n >= MAX_AUTO_RESPAWNS) {
await patchJob(ctx, job.id, { status: "failed", error: `第 ${s.seq} 镜多次生成卡住，已停止自动重试，请到画布上手动重试这一镜后再拼接。`, message: "任务失败"});
return;
}
genAttempts[String(s.id)] = n + 1;
genAttemptsChanged = true;
const childId = await createJob(ctx, projectId, "gen_video", { shotId: s.id, parentJobId: job.id}, `正在生成第 ${s.seq} 镜的真视频…`, 1);
await spawnVideoTask(ctx, projectId, s.id, childId);
}
await patchJob(ctx, job.id, {
progressDone: shotsNow.length - missing.length,
progressTotal: shotsNow.length,
message: `正在自动补齐未就绪的镜头（第 ${missing.map((s) => s.seq).join("、")} 镜）：未生成的补生成、已生成的先过人物一致性硬验，全部就绪后自动开始拼接…`,
...(genAttemptsChanged? { detail: {...detail, genAttempts} }: {}),
});
return;
}

default:
throw new Error(`未知任务类型：${job.kind}`);
}
}
