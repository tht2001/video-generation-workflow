// Drizzle schema for the video-generation workflow space.
//
// projects hold the step-1 settings + script + publish copy + final film;
// shots are the storyboard cards on the canvas; characters are the
// character-bible entries; continuity rows are the AI continuity ledger for
// each adjacent shot pair; jobs are the durable background-task records
// (every long operation is a job, advanced step by step); settings is a
// single-row table for the text-model configuration.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const createdAt = integer("created_at", { mode: "timestamp_ms" })
  .notNull()
  .$defaultFn(() => new Date());
const updatedAt = integer("updated_at", { mode: "timestamp_ms" })
  .notNull()
  .$defaultFn(() => new Date());

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull().default("未命名项目"),
  topic: text("topic").notNull().default(""),
  videoType: text("video_type").notNull().default("短剧"),
  aspect: text("aspect").notNull().default("9:16"),
  targetDuration: text("target_duration").notNull().default("60 秒"),
  audience: text("audience").notNull().default(""),
  platform: text("platform").notNull().default("抖音"),
  tone: text("tone").notNull().default(""),
  script: text("script").notNull().default(""),
  scriptVersion: integer("script_version").notNull().default(0),
  currentStep: integer("current_step").notNull().default(1),
  finalBlobKey: text("final_blob_key"),
  finalDurationSec: real("final_duration_sec"),
  finalResolution: text("final_resolution"),
  finalShotCount: integer("final_shot_count"),
  publishTitle: text("publish_title").notNull().default(""),
  publishCopy: text("publish_copy").notNull().default(""),
  publishConfirmed: integer("publish_confirmed").notNull().default(0),
  createdAt,
  updatedAt,
});

export const shots = sqliteTable("shots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  seq: integer("seq").notNull(),
  title: text("title").notNull().default(""),
  durationSec: real("duration_sec").notNull().default(5),
  visual: text("visual").notNull().default(""),
  dialogue: text("dialogue").notNull().default(""),
  promptZh: text("prompt_zh").notNull().default(""),
  startState: text("start_state").notNull().default(""),
  endState: text("end_state").notNull().default(""),
  // JSON array of character ids bound to this shot (auto-bound by name).
  characterIds: text("character_ids").notNull().default("[]"),
  posX: real("pos_x").notNull().default(0),
  posY: real("pos_y").notNull().default(0),
  // pending | generating | processing | done | failed
  // "done" only means the video file is saved. A shot is READY for
  // stitching only when it is done AND its frame-sampled consistency
  // hard-check passed (qa_status = passed). There is no manual
  // exemption: a failed shot must be regenerated and pass the gate.
  genStatus: text("gen_status").notNull().default("pending"),
  failReason: text("fail_reason"),
  quotaExceeded: integer("quota_exceeded").notNull().default(0),
  videoBlobKey: text("video_blob_key"),
  // Consistency hard gate (step 4): frames are sampled from the saved
  // video and vision-checked against every bound character's look anchor
  // (background people included). pending | checking | passed | failed
  qaStatus: text("qa_status").notNull().default("pending"),
  qaReason: text("qa_reason").notNull().default(""),
  qaModel: text("qa_model").notNull().default(""),
  qaCheckedAt: integer("qa_checked_at", { mode: "timestamp_ms" }),
  // Automatic regenerations already spent on QA failures for this shot.
  qaAttempts: integer("qa_attempts").notNull().default(0),
  // Legacy column, no longer consulted: manual exemption was removed —
  // readiness depends only on qa_status. Kept at 0 by all writers.
  verifyExempt: integer("verify_exempt").notNull().default(0),
  createdAt,
  updatedAt,
});

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  tag: text("tag").notNull().default(""),
  appearance: text("appearance").notNull().default(""),
  costume: text("costume").notNull().default(""),
  personality: text("personality").notNull().default(""),
  voice: text("voice").notNull().default(""),
  locked: integer("locked").notNull().default(0),
  imageBlobKey: text("image_blob_key"),
  // idle | generating | failed
  imageStatus: text("image_status").notNull().default("idle"),
  imageFailReason: text("image_fail_reason"),
  createdAt,
  updatedAt,
});

export const continuity = sqliteTable("continuity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  fromShotId: integer("from_shot_id").notNull(),
  toShotId: integer("to_shot_id").notNull(),
  // ok | jump | broken | null (not checked yet)
  verdict: text("verdict"),
  reason: text("reason").notNull().default(""),
  suggestion: text("suggestion").notNull().default(""),
  modelLabel: text("model_label").notNull().default(""),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
  createdAt,
  updatedAt,
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id"),
  // script | storyboard | extract_characters | describe_character |
  // describe_all | look_image | look_all | check_continuity |
  // fix_continuity | gen_video | gen_all_videos | verify_shot |
  // stitch | publish_copy
  kind: text("kind").notNull(),
  // queued | running | done | failed
  status: text("status").notNull().default("queued"),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  message: text("message").notNull().default(""),
  detail: text("detail").notNull().default("{}"),
  error: text("error"),
  taskId: text("task_id"),
  createdAt,
  updatedAt,
});

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  textSource: text("text_source").notNull().default("muse"),
  customBaseUrl: text("custom_base_url").notNull().default(""),
  customApiKey: text("custom_api_key").notNull().default(""),
  customModel: text("custom_model").notNull().default(""),
  updatedAt,
});
