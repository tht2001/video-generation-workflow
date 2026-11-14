DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '未命名项目',
  topic TEXT NOT NULL DEFAULT '',
  video_type TEXT NOT NULL DEFAULT '短剧',
  aspect TEXT NOT NULL DEFAULT '9:16',
  target_duration TEXT NOT NULL DEFAULT '60 秒',
  audience TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '抖音',
  tone TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  script_version INTEGER NOT NULL DEFAULT 0,
  current_step INTEGER NOT NULL DEFAULT 1,
  final_blob_key TEXT,
  final_duration_sec REAL,
  final_resolution TEXT,
  final_shot_count INTEGER,
  publish_title TEXT NOT NULL DEFAULT '',
  publish_copy TEXT NOT NULL DEFAULT '',
  publish_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  duration_sec REAL NOT NULL DEFAULT 5,
  visual TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '',
  prompt_zh TEXT NOT NULL DEFAULT '',
  start_state TEXT NOT NULL DEFAULT '',
  end_state TEXT NOT NULL DEFAULT '',
  character_ids TEXT NOT NULL DEFAULT '[]',
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  gen_status TEXT NOT NULL DEFAULT 'pending',
  fail_reason TEXT,
  quota_exceeded INTEGER NOT NULL DEFAULT 0,
  video_blob_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  costume TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  image_blob_key TEXT,
  image_status TEXT NOT NULL DEFAULT 'idle',
  image_fail_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE continuity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  from_shot_id INTEGER NOT NULL,
  to_shot_id INTEGER NOT NULL,
  verdict TEXT,
  reason TEXT NOT NULL DEFAULT '',
  suggestion TEXT NOT NULL DEFAULT '',
  model_label TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  text_source TEXT NOT NULL DEFAULT 'muse',
  custom_base_url TEXT NOT NULL DEFAULT '',
  custom_api_key TEXT NOT NULL DEFAULT '',
  custom_model TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_shots_project ON shots(project_id, seq);
--> statement-breakpoint
CREATE INDEX idx_characters_project ON characters(project_id);
--> statement-breakpoint
CREATE INDEX idx_continuity_project ON continuity(project_id);
--> statement-breakpoint
CREATE INDEX idx_jobs_project ON jobs(project_id, status);
