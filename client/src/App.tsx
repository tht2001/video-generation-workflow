import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";

// The artifact runs inside a sandboxed iframe where touching
// window.localStorage can throw (opaque origin / storage blocked). Any
// unguarded access during the first render crashes React and leaves a
// pure black screen, so every storage touch goes through these helpers.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable in this shell: remembering the last project is
    // a nicety, never worth crashing the page over.
  }
}

// Last-resort guard: if anything in the tree throws while rendering, show
// a readable recovery panel instead of a black void.
class RenderGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-6 text-[var(--text)]">
          <div className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
            <h1 className="font-display text-lg font-semibold">页面打开时出了问题</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--dim)]">
              工作流本身和你的项目数据都还在，只是这一屏没能画出来。点下面的按钮重新加载一次。
            </p>
            <p className="mt-2 break-all text-xs leading-5 text-[var(--bad)]">{this.state.error.message}</p>
            <button type="button" className={btnPrimary + " mt-4"} onClick={() => this.setState({ error: null })}>
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

type ProjectData = ApiResponse<typeof api, "getProject">;
type Project = ProjectData["project"];
type Shot = ProjectData["shots"][number];
type CharT = ProjectData["characters"][number];
type Job = ProjectData["jobs"][number];

const KIND_LABEL: Record<string, string> = {
  script: "生成脚本",
  storyboard: "拆分镜",
  extract_characters: "提取角色并定妆",
  describe_character: "生成角色描述",
  describe_all: "一键补齐角色描述",
  look_image: "生成定妆图",
  look_all: "一键生成全部定妆图",
  check_continuity: "连续性检查",
  fix_continuity: "一键修复全部",
  publish_copy: "整理发布文案",
  gen_video: "生成视频",
  gen_all_videos: "并发生成全部视频",
  verify_shot: "人物一致性硬验",
  stitch: "拼接成片",
};

const VERDICT_LABEL: Record<string, string> = { ok: "衔接成立", jump: "小跳跃", broken: "衔接断裂" };

function verdictColor(v: string | null): string {
  if (v === "ok") return "var(--ok)";
  if (v === "jump") return "var(--warn)";
  if (v === "broken") return "var(--bad)";
  return "var(--border)";
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)] focus:outline-none focus:border-[var(--accent)]";
const labelCls = "block text-xs font-medium text-[var(--dim)] mb-1";
const btnPrimary =
  "rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-text)] disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:brightness-95";
const btnGhost =
  "rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed hover:border-[var(--accent)]";

export function App() {
  return (
    <RenderGuard>
      <WorkflowApp />
    </RenderGuard>
  );
}

function WorkflowApp() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<number | null>(() => {
    const raw = storageGet("vgw-project-id");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  });
  const [activeStep, setActiveStep] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects({}) });
  const projects = projectsQuery.data?.projects ?? [];

  useEffect(() => {
    if (projectId == null && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  useEffect(() => {
    if (projectId != null) storageSet("vgw-project-id", String(projectId));
  }, [projectId]);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject({ projectId: projectId! }),
    enabled: projectId != null,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "running") ? 4000 : false),
  });
  const data = projectQuery.data;
  const jobs = data?.jobs ?? [];
  const runningJobs = useMemo(() => jobs.filter((j) => j.status === "running"), [jobs]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["project", projectId] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  // Drive background jobs: poll-advance every running job (one small step
  // per call). Spawn-driven jobs (video/stitch) just get their status
  // synced by the same call.
  const advancingRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const job of runningJobs) {
      if (advancingRef.current.has(job.id)) continue;
      advancingRef.current.add(job.id);
      api
        .advanceJob({ jobId: job.id })
        .catch(() => undefined)
        .finally(() => {
          advancingRef.current.delete(job.id);
          invalidate();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningJobs]);

  const startJobMut = useMutation({
    mutationFn: (args: { kind: string; shotId?: number; characterId?: number }) =>
      api.startJob({
        projectId: projectId!,
        kind: args.kind as never,
        shotId: args.shotId,
        characterId: args.characterId,
      }),
    onSuccess: (r) => {
      if (r.alreadyRunning) setNotice({ ok: true, text: "该任务已在后台运行中，进度会自动刷新，不要重复点击。" });
      invalidate();
    },
    onError: (e) => setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });
  const startJob = (kind: string, extra?: { shotId?: number; characterId?: number }) =>
    startJobMut.mutate({ kind, ...extra });

  const retryMut = useMutation({
    mutationFn: (jobId: number) => api.retryJob({ jobId }),
    onSuccess: () => {
      setNotice({ ok: true, text: "已重新启动失败的任务，只补没完成的部分。" });
      invalidate();
    },
    onError: (e) => setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  const createMut = useMutation({
    mutationFn: () => api.createProject({}),
    onSuccess: (r) => {
      setProjectId(r.project.id);
      setActiveStep(1);
      invalidate();
    },
  });

  const runningKinds = useMemo(() => new Set(runningJobs.map((j) => j.kind)), [runningJobs]);
  const project = data?.project;

  useEffect(() => {
    if (project && activeStep === 1 && project.currentStep > 1) {
      // Keep the user where they are; only auto-advance on first open.
    }
  }, [project, activeStep]);

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)] lg:flex-row">
      {/* ---------------- left workflow panel ---------------- */}
      <aside className="flex max-h-[54dvh] w-full shrink-0 flex-col border-b border-[var(--border)] bg-[var(--surface)] lg:h-full lg:max-h-none lg:w-[404px] lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <select
            aria-label="选择项目"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
            value={projectId ?? ""}
            onChange={(e) => {
              setProjectId(Number(e.target.value));
              setActiveStep(1);
            }}
          >
            {projects.length === 0 && <option value="">（还没有项目）</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {p.shotCount} 镜
              </option>
            ))}
          </select>
          <button type="button" className={btnGhost} onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            新建项目
          </button>
          <button
            type="button"
            className={btnGhost}
            aria-label="文本模型设置"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            设置
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

          {!project && (
            <div className="px-4 py-6">
              <h1 className="font-display text-xl font-semibold">视频生成工作流</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--dim)]">
                从选题到成片的六步工作流。先新建一个项目，然后在左栏一步步往下走；第三步拆出的分镜会排到右侧画布上，点任意一张分镜卡就能直接生成那一镜的真视频。
              </p>
              {projectsQuery.isPending && <p className="mt-3 text-sm text-[var(--dim)]">正在加载项目…</p>}
              {projectsQuery.isError && (
                <div className="mt-3 rounded-lg border border-[var(--bad)] px-3 py-2">
                  <p className="text-xs leading-5 text-[var(--bad)]">
                    项目列表没能加载出来：{projectsQuery.error instanceof Error ? projectsQuery.error.message : String(projectsQuery.error)}
                  </p>
                  <button type="button" className={`${btnGhost} mt-2`} onClick={() => void projectsQuery.refetch()}>
                    重新加载
                  </button>
                </div>
              )}
              {!projectsQuery.isPending && !projectsQuery.isError && projects.length === 0 && (
                <>
                  <button
                    type="button"
                    className={`${btnPrimary} mt-4 w-full py-3 text-base`}
                    onClick={() => createMut.mutate()}
                    disabled={createMut.isPending}
                  >
                    {createMut.isPending ? "正在新建…" : "＋ 新建项目，开始第一步"}
                  </button>
                  {createMut.isError && (
                    <p className="mt-2 text-xs leading-5 text-[var(--bad)]">
                      新建失败：{createMut.error instanceof Error ? createMut.error.message : String(createMut.error)}
                    </p>
                  )}
                  <ol className="mt-5 space-y-2" aria-label="六步工作流概览">
                    {STEP_TITLES.map((title, i) => (
                      <li key={title} className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
                        <span className="font-mono-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] text-xs font-bold text-[var(--accent)]">
                          {i + 1}
                        </span>
                        <span className="text-sm">
                          第{["一", "二", "三", "四", "五", "六"][i]}步 · {title}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {!projectsQuery.isPending && projects.length > 0 && projectQuery.isError && (
                <div className="mt-3 rounded-lg border border-[var(--bad)] px-3 py-2">
                  <p className="text-xs leading-5 text-[var(--bad)]">
                    项目内容没能加载出来：{projectQuery.error instanceof Error ? projectQuery.error.message : String(projectQuery.error)}
                  </p>
                  <button type="button" className={`${btnGhost} mt-2`} onClick={() => void projectQuery.refetch()}>
                    重新加载
                  </button>
                </div>
              )}
              {!projectsQuery.isPending && projects.length > 0 && !projectQuery.isError && (
                <p className="mt-3 text-sm text-[var(--dim)]">正在打开最近的项目…</p>
              )}
            </div>
          )}

          {project && data && (
            <>
              <StepNav project={project} data={data} activeStep={activeStep} setActiveStep={setActiveStep} />

              {notice && (
                <div
                  role="status"
                  className={`mx-3 mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${
                    notice.ok ? "border-[var(--ok)] text-[var(--text)]" : "border-[var(--bad)] text-[var(--text)]"
                  }`}
                >
                  {notice.text}
                  <button type="button" className="ml-2 underline" onClick={() => setNotice(null)}>
                    知道了
                  </button>
                </div>
              )}

              <JobsBar jobs={jobs} onRetry={(id) => retryMut.mutate(id)} />

              <div className="px-3 py-3">
                {activeStep === 1 && (
                  <StepSettings project={project} onSaved={() => setNotice({ ok: true, text: "选题与设定已保存。" })} />
                )}
                {activeStep === 2 && (
                  <StepScript
                    project={project}
                    startJob={startJob}
                    running={runningKinds.has("script")}
                    onNotice={setNotice}
                  />
                )}
                {activeStep === 3 && (
                  <StepStoryboard
                    data={data}
                    startJob={startJob}
                    running={runningKinds.has("storyboard")}
                    onNotice={setNotice}
                  />
                )}
                {activeStep === 4 && (
                  <StepStudio
                    data={data}
                    startJob={startJob}
                    runningKinds={runningKinds}
                    onNotice={setNotice}
                  />
                )}
                {activeStep === 5 && <StepStitch data={data} startJob={startJob} running={runningKinds.has("stitch")} />}
                {activeStep === 6 && (
                  <StepPublish data={data} startJob={startJob} running={runningKinds.has("publish_copy")} onNotice={setNotice} />
                )}
              </div>

              <ProjectDangerZone
                project={project}
                onDeleted={() => {
                  setProjectId(null);
                  invalidate();
                }}
              />
            </>
          )}
        </div>
      </aside>

      {/* ---------------- right infinite canvas ---------------- */}
      <main className="relative min-h-0 flex-1">
        {data && project ? (
          <Canvas data={data} startJob={startJob} onNotice={setNotice} />
        ) : (
          <div
            className="flex h-full items-center justify-center px-6 py-10"
            style={{
              backgroundImage: "radial-gradient(circle, #2c313a 1px, transparent 1px)",
              backgroundSize: "26px 26px",
            }}
          >
            {projects.length === 0 && !projectsQuery.isPending ? (
              <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-lg">
                <h2 className="font-display text-xl font-semibold">分镜画布</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--dim)]">
                  这里是分镜的舞台：写好脚本、拆出分镜后，分镜卡会自动排到这块画布上并按剧情顺序连线，可以拖动、缩放，点任意一张卡就能生成那一镜的真视频。
                </p>
                <button
                  type="button"
                  className={`${btnPrimary} mt-4 w-full py-3 text-base`}
                  onClick={() => createMut.mutate()}
                  disabled={createMut.isPending}
                >
                  {createMut.isPending ? "正在新建…" : "＋ 新建第一个项目"}
                </button>
                <p className="mt-3 text-xs leading-5 text-[var(--dim)]">新建后，左栏第一步先填选题与设定。</p>
              </div>
            ) : (
              <p className="text-center text-sm text-[var(--dim)]">正在加载画布…</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------ step nav

function stepDone(n: number, project: Project, data: ProjectData): boolean {
  switch (n) {
    case 1:
      return project.topic.trim().length > 0;
    case 2:
      return project.script.trim().length > 0;
    case 3:
      return data.shots.length > 0;
    case 4:
      return data.shots.length > 0 && data.shots.every((s) => s.ready);
    case 5:
      return project.hasFinal;
    case 6:
      return project.publishConfirmed;
    default:
      return false;
  }
}

const STEP_TITLES = ["选题与设定", "脚本", "分镜", "定妆 · 检查 · 生成", "拼接成片", "导出与发布"];

function StepNav({
  project,
  data,
  activeStep,
  setActiveStep,
}: {
  project: Project;
  data: ProjectData;
  activeStep: number;
  setActiveStep: (n: number) => void;
}) {
  return (
    <nav aria-label="六步工作流" className="grid grid-cols-3 gap-1.5 px-3 pt-3 lg:grid-cols-2">
      {STEP_TITLES.map((title, i) => {
        const n = i + 1;
        const done = stepDone(n, project, data);
        const active = activeStep === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => setActiveStep(n)}
            aria-current={active ? "step" : undefined}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] ${
              active ? "border-[var(--accent)] bg-[var(--surface2)]" : "border-[var(--border)] bg-[var(--bg)]"
            }`}
          >
            <span
              className="font-mono-num flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
              style={{
                background: done ? "var(--ok)" : active ? "var(--accent)" : "var(--surface2)",
                color: done || active ? "#14161a" : "var(--dim)",
              }}
            >
              {done ? "✓" : n}
            </span>
            <span className="leading-tight">
              第{["一", "二", "三", "四", "五", "六"][i]}步
              <br />
              <span className="text-[var(--dim)]">{title}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ------------------------------------------------------------ jobs bar

const PER_ENTITY_JOB_KINDS = new Set(["gen_video", "describe_character", "look_image"]);

function JobsBar({ jobs, onRetry }: { jobs: Job[]; onRetry: (id: number) => void }) {
  const visible = jobs
    .filter((j) => {
      if (j.status === "running") return true;
      if (j.status !== "failed") return false;
      // A project-scoped failure that a newer job of the same kind has
      // since completed (or is now handling) is history, not a current
      // problem: don't keep showing its old error text next to the fixed
      // state as if it were still true.
      if (PER_ENTITY_JOB_KINDS.has(j.kind)) return true;
      return !jobs.some((o) => o.id > j.id && o.kind === j.kind && (o.status === "done" || o.status === "running"));
    })
    .slice(0, 4);
  if (visible.length === 0) return null;
  return (
    <div className="mx-3 mt-3 space-y-2">
      {visible.map((j) => (
        <div key={j.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">{KIND_LABEL[j.kind] ?? j.kind}</span>
            {j.status === "running" && j.progressTotal > 0 && (
              <span className="font-mono-num text-[11px] text-[var(--dim)]">
                {j.progressDone} / {j.progressTotal}
              </span>
            )}
            {j.status === "failed" && (
              <button type="button" className="text-xs font-semibold text-[var(--accent)] underline" onClick={() => onRetry(j.id)}>
                重试（只补未完成）
              </button>
            )}
          </div>
          {j.status === "running" && j.progressTotal > 0 && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-[var(--surface2)]">
              <div
                className="h-full bg-[var(--accent)] transition-all"
                style={{ width: `${Math.min(100, (j.progressDone / Math.max(1, j.progressTotal)) * 100)}%` }}
              />
            </div>
          )}
          <p className="mt-1 text-xs leading-5 text-[var(--dim)]">{j.status === "failed" ? (j.error ?? j.message) : j.message}</p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ settings

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const s = settingsQuery.data;
  const [source, setSource] = useState<string>("muse");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (s && !loaded) {
      setSource(s.textSource);
      setBaseUrl(s.customBaseUrl);
      setModel(s.customModel);
      setLoaded(true);
    }
  }, [s, loaded]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.updateSettings({
        textSource: source as "muse" | "custom",
        customBaseUrl: baseUrl,
        customModel: model,
        customApiKey: apiKey || undefined,
      }),
    onSuccess: () => {
      setApiKey("");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
  });
  const testMut = useMutation({
    mutationFn: () => api.testCustomConnection({ customBaseUrl: baseUrl, customModel: model, customApiKey: apiKey || undefined }),
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <section aria-label="文本模型设置" className="mx-3 mt-3 rounded-xl border border-[var(--accent)] bg-[var(--bg)] p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold">文本模型设置</h2>
        <button type="button" className="text-xs text-[var(--dim)] underline" onClick={onClose}>
          收起
        </button>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
        只管文本任务（脚本、分镜、提取角色、角色描述、连续性检查与修复、发布文案）。定妆图、视频生成与拼接永远只用 Muse，不走自定义模型。
      </p>
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="text-source" checked={source === "muse"} onChange={() => setSource("muse")} />
          用 Muse（默认）
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="text-source" checked={source === "custom"} onChange={() => setSource("custom")} />
          用我自己的文本模型（OpenAI 兼容接口）
        </label>
      </div>
      {source === "custom" && (
        <div className="mt-3 space-y-2.5">
          <div>
            <label className={labelCls} htmlFor="cfg-base">接口地址（API Base URL）</label>
            <input id="cfg-base" className={inputCls} placeholder="例如 https://api.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cfg-model">模型名称</label>
            <input id="cfg-model" className={inputCls} placeholder="例如 gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cfg-key">API Key{ s?.hasApiKey ? `（已保存：${s.apiKeyMasked}，留空不改）` : ""}</label>
            <input id="cfg-key" type="password" className={inputCls} placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnGhost} onClick={() => testMut.mutate()} disabled={testMut.isPending || !baseUrl || !model}>
              {testMut.isPending ? "测试中…" : "测试连接"}
            </button>
            <button type="button" className={btnGhost} onClick={() => setSource("muse")}>
              一键切回 Muse
            </button>
          </div>
          {testResult && (
            <p role="status" className={`text-xs leading-5 ${testResult.ok ? "text-[var(--ok)]" : "text-[var(--bad)]"}`}>
              {testResult.message}
            </p>
          )}
        </div>
      )}
      <button type="button" className={`${btnPrimary} mt-3 w-full`} onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
        {saveMut.isPending ? "保存中…" : "保存设置"}
      </button>
      {saveMut.isSuccess && <p className="mt-1.5 text-xs text-[var(--ok)]">已保存，新发起的文本任务立即按新设置走。</p>}
    </section>
  );
}

// ------------------------------------------------------------ step 1

function StepSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    title: project.title,
    topic: project.topic,
    videoType: project.videoType,
    aspect: project.aspect,
    targetDuration: project.targetDuration,
    audience: project.audience,
    platform: project.platform,
    tone: project.tone,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const saveMut = useMutation({
    mutationFn: () => api.updateProjectSettings({ projectId: project.id, ...form, aspect: form.aspect as "9:16" | "16:9" }),
    onSuccess: () => {
      onSaved();
      void qc.invalidateQueries({ queryKey: ["project"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <section aria-label="第一步 选题与设定" className="space-y-3">
      <h2 className="font-display text-lg font-semibold">第一步 · 选题与设定</h2>
      <div>
        <label className={labelCls} htmlFor="p-title">项目名称</label>
        <input id="p-title" className={inputCls} value={form.title} onChange={set("title")} />
      </div>
      <div>
        <label className={labelCls} htmlFor="p-topic">题材 / 主题</label>
        <textarea id="p-topic" className={inputCls} rows={3} placeholder="例如：离婚当天，前夫跪求复婚的都市逆袭故事" value={form.topic} onChange={set("topic")} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls} htmlFor="p-type">视频类型</label>
          <select id="p-type" className={inputCls} value={form.videoType} onChange={set("videoType")}>
            {["短剧", "漫剧 / 绘本", "口播短视频", "产品种草视频", "宣传片", "教程", "其他"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="p-platform">发布平台</label>
          <select id="p-platform" className={inputCls} value={form.platform} onChange={set("platform")}>
            {["抖音", "快手", "红果短剧", "小红书", "微信视频号", "B站", "YouTube", "其他"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="p-aspect">画幅</label>
          <select id="p-aspect" className={inputCls} value={form.aspect} onChange={set("aspect")}>
            <option value="9:16">竖屏 9:16</option>
            <option value="16:9">横屏 16:9</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="p-duration">目标时长</label>
          <input id="p-duration" className={inputCls} placeholder="例如 90 秒" value={form.targetDuration} onChange={set("targetDuration")} />
        </div>
        <div>
          <label className={labelCls} htmlFor="p-audience">目标受众</label>
          <input id="p-audience" className={inputCls} placeholder="例如 25–40 岁女性" value={form.audience} onChange={set("audience")} />
        </div>
        <div>
          <label className={labelCls} htmlFor="p-tone">整体基调</label>
          <input id="p-tone" className={inputCls} placeholder="例如 爽感逆袭、节奏快" value={form.tone} onChange={set("tone")} />
        </div>
      </div>
      <button type="button" className={`${btnPrimary} w-full`} onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
        {saveMut.isPending ? "保存中…" : "保存设定"}
      </button>
    </section>
  );
}

// ------------------------------------------------------------ step 2

function StepScript({
  project,
  startJob,
  running,
  onNotice,
}: {
  project: Project;
  startJob: (kind: string) => void;
  running: boolean;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(project.script);
  const loadedKey = useRef(`${project.id}:${project.scriptVersion}`);
  useEffect(() => {
    const key = `${project.id}:${project.scriptVersion}`;
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setDraft(project.script);
    }
  }, [project.id, project.scriptVersion, project.script]);

  const saveMut = useMutation({
    mutationFn: () => api.saveScript({ projectId: project.id, script: draft }),
    onSuccess: () => {
      onNotice({ ok: true, text: "脚本已保存。" });
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <section aria-label="第二步 脚本" className="space-y-3">
      <h2 className="font-display text-lg font-semibold">第二步 · 脚本</h2>
      <p className="text-xs leading-5 text-[var(--dim)]">
        可以按选题自动生成完整脚本，也可以直接粘贴已有脚本。保存后的脚本不会被重新生成弄丢：重新生成时，上一版会保留在该任务的记录里。
      </p>
      <button type="button" className={`${btnPrimary} w-full`} disabled={running} onClick={() => startJob("script")}>
        {running ? "脚本生成中（后台进行）…" : project.script.trim() ? "重新生成脚本" : "根据选题生成脚本"}
      </button>
      <div>
        <label className={labelCls} htmlFor="script-text">
          脚本内容（{draft.length} 字）
        </label>
        <textarea
          id="script-text"
          className={`${inputCls} leading-6`}
          rows={16}
          placeholder="在这里粘贴已有脚本，或点上方按钮自动生成…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <button type="button" className={`${btnGhost} w-full`} disabled={saveMut.isPending || draft === project.script} onClick={() => saveMut.mutate()}>
        {saveMut.isPending ? "保存中…" : "保存脚本"}
      </button>
    </section>
  );
}

// ------------------------------------------------------------ step 3

function StepStoryboard({
  data,
  startJob,
  running,
  onNotice,
}: {
  data: ProjectData;
  startJob: (kind: string) => void;
  running: boolean;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const hasShots = data.shots.length > 0;
  const addMut = useMutation({
    mutationFn: () => api.addShot({ projectId: data.project.id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project"] }),
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });
  return (
    <section aria-label="第三步 分镜" className="space-y-3">
      <h2 className="font-display text-lg font-semibold">第三步 · 分镜</h2>
      <p className="text-xs leading-5 text-[var(--dim)]">
        把脚本按段拆成一个个分镜（长脚本分段处理、逐段回传），自动排到右侧画布并按剧情顺序连线。每张卡包含画面、台词、中文提示词与开场/结尾状态，下一镜开场承接上一镜结尾。
      </p>
      {hasShots && !confirming && (
        <button type="button" className={`${btnGhost} w-full`} disabled={running} onClick={() => setConfirming(true)}>
          重新拆分镜（现有 {data.shots.length} 镜）
        </button>
      )}
      {hasShots && confirming && (
        <div className="rounded-lg border border-[var(--bad)] p-3">
          <p className="text-xs leading-5">重新拆分镜会清空现有分镜卡和已生成的视频片段，确定继续吗？</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                setConfirming(false);
                startJob("storyboard");
              }}
            >
              确定重拆
            </button>
            <button type="button" className={btnGhost} onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      {!hasShots && (
        <button type="button" className={`${btnPrimary} w-full`} disabled={running || !data.project.script.trim()} onClick={() => startJob("storyboard")}>
          {running ? "正在拆分镜…" : "把脚本拆成分镜"}
        </button>
      )}
      {!data.project.script.trim() && <p className="text-xs text-[var(--bad)]">脚本还是空的，请先完成第二步。</p>}
      {hasShots && (
        <p className="text-sm text-[var(--dim)]">
          当前共 <span className="font-mono-num text-[var(--text)]">{data.shots.length}</span> 镜，已生成并通过硬验{" "}
          <span className="font-mono-num text-[var(--text)]">{data.shots.filter((s) => s.ready).length}</span> 镜。在画布上点任意卡片即可生成那一镜。
        </p>
      )}
      <button type="button" className={`${btnGhost} w-full`} onClick={() => addMut.mutate()} disabled={addMut.isPending}>
        手动新增一镜
      </button>
    </section>
  );
}

// ------------------------------------------------------------ step 4

function StepStudio({
  data,
  startJob,
  runningKinds,
  onNotice,
}: {
  data: ProjectData;
  startJob: (kind: string, extra?: { shotId?: number; characterId?: number }) => void;
  runningKinds: Set<string>;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const chars = data.characters;
  const needDesc = chars.filter((c) => !c.descriptionComplete).length;
  const needLook = chars.filter((c) => !c.imageUrl).length;
  const badPairs = data.continuity.filter((r) => r.verdict === "jump" || r.verdict === "broken").length;
  const pendingShots = data.shots.filter((s) => !s.ready).length;
  const qaFailedShots = data.shots.filter((s) => s.genStatus === "done" && s.qaStatus === "failed");
  const extractRunning = runningKinds.has("extract_characters");

  return (
    <section aria-label="第四步 定妆、检查与生成" className="space-y-5">
      <h2 className="font-display text-lg font-semibold">第四步 · 定妆 · 检查 · 生成</h2>

      {/* ---- character studio ---- */}
      <div>
        <h3 className="text-sm font-semibold">角色棚 / 角色圣经</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
          先锁定每个角色的外貌、服装、性格、声音与定妆图，生成视频时会自动带入定妆描述、定妆图和上一镜结尾状态三重约束。点一次「从脚本提取角色」，后台会分段提取 → 逐个补描述 → 并发（每批 3 个）生成定妆图，一条链走完；继续提取只补缺、绝不覆盖已填好或已锁定的定妆。
        </p>
        <div className="mt-2.5 grid grid-cols-1 gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={extractRunning || !data.project.script.trim()}
            onClick={() => startJob("extract_characters")}
          >
            {extractRunning
              ? "提取链路进行中…"
              : chars.length === 0
                ? "从脚本提取角色"
                : "继续提取（只补缺，不覆盖）"}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={runningKinds.has("describe_all") || needDesc === 0}
              onClick={() => startJob("describe_all")}
            >
              一键生成角色描述（{needDesc} 个待补）
            </button>
            <button
              type="button"
              className={btnGhost}
              disabled={runningKinds.has("look_all") || needLook === 0}
              onClick={() => startJob("look_all")}
            >
              一键生成全部定妆图（{needLook} 个待生成）
            </button>
          </div>
        </div>
        <NewCharacterForm projectId={data.project.id} onNotice={onNotice} />
        <div className="mt-3 space-y-3">
          {chars.length === 0 && <p className="text-xs text-[var(--dim)]">角色棚还是空的：从脚本提取，或手动新建一个角色。</p>}
          {chars.map((c) => (
            <CharacterCard key={c.id} c={c} startJob={startJob} onNotice={onNotice} />
          ))}
        </div>
      </div>

      {/* ---- continuity ledger ---- */}
      <div>
        <h3 className="text-sm font-semibold">AI 场记 · 连续性台账</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
          逐对核对相邻分镜的时间、场景、服装、道具、情绪、位置与开场/结尾状态，只用中文提示词。检查并发进行（当前文本来源：{data.textModelLabel}），结论同步写回台账、画布卡片与连线颜色。
        </p>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={runningKinds.has("check_continuity") || data.shots.length < 2}
            onClick={() => startJob("check_continuity")}
          >
            {runningKinds.has("check_continuity") ? "检查中…" : "连续性检查"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={runningKinds.has("fix_continuity") || badPairs === 0}
            onClick={() => startJob("fix_continuity")}
          >
            一键修复全部（{badPairs}）
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {data.continuity.length === 0 && <p className="text-xs text-[var(--dim)]">暂无相邻分镜对。</p>}
          {data.continuity.map((r) => (
            <div key={r.id} className="rounded-lg border bg-[var(--bg)] px-3 py-2" style={{ borderColor: verdictColor(r.verdict) }}>
              <div className="flex items-center justify-between">
                <span className="font-mono-num text-xs">
                  第 {r.fromSeq} 镜 → 第 {r.toSeq} 镜
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                  style={{ color: verdictColor(r.verdict), border: `1px solid ${verdictColor(r.verdict)}` }}
                >
                  {r.verdict ? VERDICT_LABEL[r.verdict] : "未检查"}
                </span>
              </div>
              {r.verdict && (
                <div className="mt-1 text-xs leading-5 text-[var(--dim)]">
                  <p>{r.reason}</p>
                  {r.suggestion && <p className="mt-0.5">建议：{r.suggestion}</p>}
                  {r.modelLabel && <p className="mt-0.5">核对模型：{r.modelLabel}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---- video generation ---- */}
      <div>
        <h3 className="text-sm font-semibold">视频生成（真视频）· 人物一致性硬门禁</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
          点画布上任意一张分镜卡即可生成那一镜；也可以并发生成全部：一批最多同时 6 条，更多自动拆批。每镜生成时带入本镜全部出场角色的定妆锚图——包括只在背景出现的人物——并把每个人的性别、外貌、发型、服装特征写死在提示词里，名单之外不允许出现任何人物。
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--dim)]">
          生成完不是终点：工作流会从成片里抽帧，逐人（含背景里只露半边的人）与定妆锚图硬验。验不过就自动作废、重新生成（最多 2 次）；仍不过会停下来报错，只能在卡片上重新生成、通过硬验后才能继续。<strong className="text-[var(--text)]">没通过硬验的镜头，进不了第五步拼接——没有人工放行。</strong>某一镜长时间卡住没有回写时会自动判定卡住并重新生成；额度用完会明确提示。每镜带声音：台词由人物开口说出做口型同步，旁白为画外音。
        </p>
        <button
          type="button"
          className={`${btnPrimary} mt-2.5 w-full`}
          disabled={runningKinds.has("gen_all_videos") || pendingShots === 0}
          onClick={() => startJob("gen_all_videos")}
        >
          {runningKinds.has("gen_all_videos") ? "并发生成中…" : `并发生成全部（${pendingShots} 镜待生成 / 待硬验）`}
        </button>
        {qaFailedShots.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {qaFailedShots.map((s) => (
              <p key={s.id} className="rounded-lg border border-[var(--bad)] px-2.5 py-1.5 text-xs leading-5 text-[var(--bad)]">
                第 {s.seq} 镜硬验未通过：{s.qaReason || "人物与定妆锚对不上"}（已自动重生成 {s.qaAttempts}/{s.qaMaxAttempts} 次，去画布卡片上处理）
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function NewCharacterForm({ projectId, onNotice }: { projectId: number; onNotice: (n: { ok: boolean; text: string }) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => api.upsertCharacter({ projectId, name: name.trim() }),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });
  return (
    <form
      className="mt-2.5 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) mut.mutate();
      }}
    >
      <input aria-label="新角色名字" className={inputCls} placeholder="手动新建角色：输入名字" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className={`${btnGhost} shrink-0`} disabled={!name.trim() || mut.isPending}>
        新建
      </button>
    </form>
  );
}

function CharacterCard({
  c,
  startJob,
  onNotice,
}: {
  c: CharT;
  startJob: (kind: string, extra?: { shotId?: number; characterId?: number }) => void;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [form, setForm] = useState({ name: c.name, appearance: c.appearance, costume: c.costume, personality: c.personality, voice: c.voice });
  useEffect(() => {
    setForm({ name: c.name, appearance: c.appearance, costume: c.costume, personality: c.personality, voice: c.voice });
  }, [c.id, c.name, c.appearance, c.costume, c.personality, c.voice]);

  const saveMut = useMutation({
    mutationFn: () => api.upsertCharacter({ projectId: 0, characterId: c.id, ...form }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });
  const lockMut = useMutation({
    mutationFn: () => api.upsertCharacter({ projectId: 0, characterId: c.id, name: c.name, locked: !c.locked }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project"] }),
  });
  const delMut = useMutation({
    mutationFn: () => api.deleteCharacter({ characterId: c.id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project"] }),
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  const lookLabel = c.imageUrl ? "重新生成定妆图" : "生成定妆图";
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex gap-3">
        <div className="w-20 shrink-0">
          {c.imageUrl ? (
            <img src={c.imageUrl} alt={`${c.name}的定妆图`} className="aspect-[3/4] w-full rounded-lg object-cover" />
          ) : (
            <div className="flex aspect-[3/4] w-full items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-1 text-center text-[11px] text-[var(--dim)]">
              {c.imageStatus === "generating" ? "定妆图生成中…" : "暂无定妆图"}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{c.name}</span>
            <span className="font-mono-num rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[11px] text-[var(--accent)]">{c.tag}</span>
            {c.locked && <span className="rounded bg-[var(--ok)] px-1.5 py-0.5 text-[11px] font-semibold text-[#14161a]">已锁定</span>}
            {!c.descriptionComplete && <span className="rounded border border-[var(--warn)] px-1.5 py-0.5 text-[11px] text-[var(--warn)]">待定妆</span>}
          </div>
          {!editing ? (
            <dl className="mt-1.5 space-y-0.5 text-xs leading-5 text-[var(--dim)]">
              <div><span className="text-[var(--text)]">外貌：</span>{c.appearance || "（未填）"}</div>
              <div><span className="text-[var(--text)]">服装：</span>{c.costume || "（未填）"}</div>
              <div><span className="text-[var(--text)]">性格：</span>{c.personality || "（未填）"}</div>
              <div><span className="text-[var(--text)]">声音：</span>{c.voice || "（未填）"}</div>
            </dl>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              {(
                [
                  ["name", "名字"],
                  ["appearance", "外貌"],
                  ["costume", "服装"],
                  ["personality", "性格"],
                  ["voice", "声音"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <label className={labelCls} htmlFor={`cc-${c.id}-${key}`}>{label}</label>
                  <textarea
                    id={`cc-${c.id}-${key}`}
                    className={inputCls}
                    rows={key === "name" ? 1 : 2}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
          {c.imageStatus === "failed" && c.imageFailReason && <p className="mt-1.5 text-xs leading-5 text-[var(--bad)]">{c.imageFailReason}</p>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {/* Order matters: 生成角色描述 must come before 生成定妆图. */}
        <button type="button" className={btnGhost} onClick={() => startJob("describe_character", { characterId: c.id })}>
          生成角色描述
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={c.imageStatus === "generating"}
          onClick={() => {
            if (!c.descriptionComplete) {
              onNotice({ ok: true, text: `${c.name} 还缺定妆描述，已先为它补描述再生成定妆图（后台自动衔接）。` });
            }
            startJob("look_image", { characterId: c.id });
          }}
        >
          {c.imageStatus === "generating" ? "定妆图生成中…" : lookLabel}
        </button>
        {editing ? (
          <button type="button" className={btnPrimary} onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            保存定妆
          </button>
        ) : (
          <button type="button" className={btnGhost} onClick={() => setEditing(true)}>
            编辑
          </button>
        )}
        <button type="button" className={btnGhost} onClick={() => lockMut.mutate()} disabled={lockMut.isPending}>
          {c.locked ? "解除锁定" : "锁定定妆"}
        </button>
        <button
          type="button"
          className={btnGhost}
          onClick={() => {
            if (confirmDel) delMut.mutate();
            else {
              setConfirmDel(true);
              window.setTimeout(() => setConfirmDel(false), 3000);
            }
          }}
        >
          {confirmDel ? "再点一次确认删除" : "删除"}
        </button>
      </div>
    </article>
  );
}

// ------------------------------------------------------------ step 5

function StepStitch({ data, startJob, running }: { data: ProjectData; startJob: (kind: string) => void; running: boolean }) {
  const p = data.project;
  const total = data.shots.length;
  const done = data.shots.filter((s) => s.ready).length;
  const allDone = total > 0 && done === total;
  const qaBlocked = data.shots.filter((s) => s.genStatus === "done" && !s.ready);
  return (
    <section aria-label="第五步 拼接成片" className="space-y-3">
      <h2 className="font-display text-lg font-semibold">第五步 · 拼接成片</h2>
      <p className="text-xs leading-5 text-[var(--dim)]">
        把全部已就绪的分镜片段拼成一个完整成片：只保留每一镜原片自带的声音（不会再配一遍旁白），只烧录字幕——白字、黑色描边、无背景底色。短片用尾帧定格加叠化过渡，长片用无损直接拼接。<strong className="text-[var(--text)]">人物一致性硬验没通过的镜头不能拼接，没有例外</strong>：点下面按钮会先把未就绪的镜头补生成、复验或重生成，全部通过硬验后才开始拼接。
      </p>
      <p className="text-sm text-[var(--dim)]">
        已就绪 <span className="font-mono-num text-[var(--text)]">{done}</span> / <span className="font-mono-num text-[var(--text)]">{total}</span> 镜
        {!allDone && total > 0 && "，还没齐也没关系：点下面按钮会自动补齐，全部就绪后自动开始拼接。"}
      </p>
      {qaBlocked.length > 0 && (
        <div className="space-y-1.5">
          {qaBlocked.map((s) => (
            <p key={s.id} className="rounded-lg border border-[var(--warn)] px-2.5 py-1.5 text-xs leading-5 text-[var(--warn)]">
              第 {s.seq} 镜{s.qaStatus === "failed" ? `硬验未通过：${s.qaReason || "人物与定妆锚对不上"}` : "已生成、还没通过人物一致性硬验"}，通过前不能拼接。
            </p>
          ))}
        </div>
      )}
      <button type="button" className={`${btnPrimary} w-full`} disabled={running || total === 0} onClick={() => startJob("stitch")}>
        {running ? "正在自动补齐并拼接（后台进行）…" : allDone ? "拼接成片" : "补齐未就绪镜头并拼接"}
      </button>
      {p.hasFinal && p.finalUrl && (
        <div className="space-y-2">
          <video src={p.finalUrl} controls className="w-full rounded-xl bg-black" aria-label="成片预览" />
          <dl className="grid grid-cols-3 gap-2 text-center text-xs text-[var(--dim)]">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] py-2">
              总时长<br /><span className="font-mono-num text-sm text-[var(--text)]">{p.finalDurationSec ?? "—"} 秒</span>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] py-2">
              分辨率<br /><span className="font-mono-num text-sm text-[var(--text)]">{p.finalResolution ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] py-2">
              镜头数<br /><span className="font-mono-num text-sm text-[var(--text)]">{p.finalShotCount ?? "—"}</span>
            </div>
          </dl>
          <a href={p.finalUrl} download className={`${btnGhost} block text-center`}>
            下载成片 MP4
          </a>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ step 6

function StepPublish({
  data,
  startJob,
  running,
  onNotice,
}: {
  data: ProjectData;
  startJob: (kind: string) => void;
  running: boolean;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const p = data.project;
  const [title, setTitle] = useState(p.publishTitle);
  const [copy, setCopy] = useState(p.publishCopy);
  const loadedKey = useRef(`${p.id}:${p.publishTitle}:${p.publishCopy}`);
  useEffect(() => {
    const key = `${p.id}:${p.publishTitle}:${p.publishCopy}`;
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setTitle(p.publishTitle);
      setCopy(p.publishCopy);
    }
  }, [p.id, p.publishTitle, p.publishCopy]);

  const saveMut = useMutation({
    mutationFn: (confirmed: boolean) => api.savePublishCopy({ projectId: p.id, publishTitle: title, publishCopy: copy, confirmed }),
    onSuccess: (_r, confirmed) => {
      onNotice({ ok: true, text: confirmed ? "已确认文案与视频。请自行到平台发布，本工作流不会自动发布。" : "标题与文案已保存（尚未确认）。" });
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <section aria-label="第六步 导出与发布" className="space-y-3">
      <h2 className="font-display text-lg font-semibold">第六步 · 导出与发布</h2>
      {p.hasFinal && p.finalUrl ? (
        <>
          <video src={p.finalUrl} controls className="w-full rounded-xl bg-black" aria-label="发布前确认成片" />
          <a href={p.finalUrl} download className={`${btnGhost} block text-center`}>
            下载成片 MP4
          </a>
        </>
      ) : (
        <p className="text-xs leading-5 text-[var(--dim)]">成片还没有生成，请先完成第五步拼接。</p>
      )}
      <button type="button" className={`${btnGhost} w-full`} disabled={running} onClick={() => startJob("publish_copy")}>
        {running ? "正在整理…" : "AI 整理发布标题和文案"}
      </button>
      <div>
        <label className={labelCls} htmlFor="pub-title">发布标题</label>
        <input id="pub-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="发布标题" />
      </div>
      <div>
        <label className={labelCls} htmlFor="pub-copy">发布文案</label>
        <textarea id="pub-copy" className={inputCls} rows={5} value={copy} onChange={(e) => setCopy(e.target.value)} placeholder="发布文案与话题标签" />
      </div>
      <button type="button" className={`${btnGhost} w-full`} disabled={saveMut.isPending} onClick={() => saveMut.mutate(false)}>
        保存标题与文案
      </button>
      <div className="rounded-lg border border-[var(--warn)] p-3">
        <p className="text-xs leading-5">
          发布到{p.platform}之前必须由你本人确认：请先看完上面的成片、核对标题与文案，再点确认。本工作流不会自动发布到任何平台。
        </p>
        <button type="button" className={`${btnPrimary} mt-2 w-full`} disabled={saveMut.isPending || !p.hasFinal} onClick={() => saveMut.mutate(true)}>
          {p.publishConfirmed ? "已确认文案与视频 ✓" : "我确认文案与视频无误"}
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ danger zone

function ProjectDangerZone({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.deleteProject({ projectId: project.id }),
    onSuccess: onDeleted,
  });
  return (
    <div className="px-3 pb-5 pt-2">
      {!confirming ? (
        <button type="button" className="text-xs text-[var(--dim)] underline" onClick={() => setConfirming(true)}>
          删除这个项目
        </button>
      ) : (
        <div className="rounded-lg border border-[var(--bad)] p-3">
          <p className="text-xs leading-5">删除后，该项目的脚本、分镜、角色与任务记录都会清除（成片文件保留在存储中但不再关联）。确定删除？</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnPrimary} onClick={() => mut.mutate()} disabled={mut.isPending}>
              确定删除
            </button>
            <button type="button" className={btnGhost} onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ canvas

const CARD_W = 344;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function Canvas({
  data,
  startJob,
  onNotice,
}: {
  data: ProjectData;
  startJob: (kind: string, extra?: { shotId?: number; characterId?: number }) => void;
  onNotice: (n: { ok: boolean; text: string }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stacked = useMediaQuery("(max-width: 1023.5px)");
  const [view, setView] = useState({ x: 30, y: 24, k: 0.8 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<Map<number, { x: number; y: number }>>(new Map());
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const cardDragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const qc = useQueryClient();

  const shots = data.shots;
  const posOf = (s: Shot) => dragPos.get(s.id) ?? { x: s.posX, y: s.posY };
  const worldW = Math.max(2600, ...shots.map((s) => posOf(s).x + CARD_W + 200));
  const worldH = Math.max(1800, ...shots.map((s) => posOf(s).y + 420));

  const pairVerdict = useMemo(() => {
    const m = new Map<number, string | null>();
    for (const r of data.continuity) m.set(r.fromShotId, r.verdict);
    return m;
  }, [data.continuity]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k2 = Math.min(1.8, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
        const wx = (mx - v.x) / v.k;
        const wy = (my - v.y) / v.k;
        return { k: k2, x: mx - wx * k2, y: my - wy * k2 };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPanStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-card]")) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: React.PointerEvent) => {
    if (panRef.current) {
      const p = panRef.current;
      setView((v) => ({ ...v, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) }));
    }
    if (cardDragRef.current) {
      const d = cardDragRef.current;
      const dx = (e.clientX - d.sx) / view.k;
      const dy = (e.clientY - d.sy) / view.k;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      setDragPos((m) => new Map(m).set(d.id, { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) }));
    }
  };
  const onPanEnd = () => {
    panRef.current = null;
    const d = cardDragRef.current;
    cardDragRef.current = null;
    if (d?.moved) {
      const p = dragPos.get(d.id);
      if (p) {
        api
          .updateShot({ shotId: d.id, posX: Math.round(p.x), posY: Math.round(p.y) })
          .then(() => void qc.invalidateQueries({ queryKey: ["project"] }))
          .catch(() => undefined);
      }
    }
  };

  const doneCount = shots.filter((s) => s.genStatus === "done").length;

  // Phone / narrow layout: the pan-and-zoom canvas would push most cards
  // off-screen with no way to reach their buttons, so below the lg
  // breakpoint the shots render as a plain vertical list in reading order.
  if (stacked) {
    return (
      <div className="h-full overflow-y-auto px-3 py-3" role="region" aria-label="分镜列表">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="font-mono-num text-xs text-[var(--dim)]">
            已生成 {doneCount} / {shots.length} 镜
          </span>
          <span className="text-[11px] text-[var(--dim)]">按剧情顺序上下排列，点卡片按钮即可生成</span>
        </div>
        <div className="flex flex-col gap-3 pb-4">
          {shots.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              data={data}
              pos={posOf(s)}
              selected={selectedId === s.id}
              onSelect={() => setSelectedId(s.id)}
              onDragStart={() => undefined}
              startJob={startJob}
              onNotice={onNotice}
              stacked
            />
          ))}
          {shots.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 text-sm leading-6 text-[var(--dim)]">
              还没有分镜。完成左侧第二步脚本后，在第三步点「把脚本拆成分镜」，分镜卡会按剧情顺序排到这里。
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none overflow-hidden"
      style={{
        backgroundImage: "radial-gradient(circle, #2c313a 1px, transparent 1px)",
        backgroundSize: "26px 26px",
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      role="application"
      aria-label="分镜无限画布，可拖动平移、滚轮缩放"
    >
      <div
        className="absolute left-0 top-0"
        style={{ width: worldW, height: worldH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
      >
        <svg className="pointer-events-none absolute left-0 top-0" width={worldW} height={worldH} aria-hidden="true">
          {shots.slice(0, -1).map((s, i) => {
            const next = shots[i + 1]!;
            const a = posOf(s);
            const b = posOf(next);
            const x1 = a.x + CARD_W;
            const y1 = a.y + 110;
            const x2 = b.x;
            const y2 = b.y + 110;
            const mid = Math.max(40, Math.abs(x2 - x1) / 2);
            const verdict = pairVerdict.get(s.id);
            return (
              <path
                key={s.id}
                d={`M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={verdictColor(verdict ?? null)}
                strokeWidth={verdict ? 3 : 2}
                strokeDasharray={verdict ? undefined : "6 6"}
              />
            );
          })}
        </svg>
        {shots.map((s) => (
          <ShotCard
            key={s.id}
            shot={s}
            data={data}
            pos={posOf(s)}
            selected={selectedId === s.id}
            onSelect={() => setSelectedId(s.id)}
            onDragStart={(e) => {
              e.stopPropagation();
              cardDragRef.current = { id: s.id, sx: e.clientX, sy: e.clientY, ox: posOf(s).x, oy: posOf(s).y, moved: false };
            }}
            startJob={startJob}
            onNotice={onNotice}
          />
        ))}
        {shots.length === 0 && (
          <div className="absolute left-10 top-10 max-w-sm rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 text-sm leading-6 text-[var(--dim)]">
            画布还是空的。完成左侧第二步脚本后，在第三步点「把脚本拆成分镜」，分镜卡会自动排到这里并按剧情顺序连线。
          </div>
        )}
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <span className="font-mono-num text-xs text-[var(--dim)]">
          已生成 {doneCount} / {shots.length} 镜
        </span>
        <button type="button" className={btnGhost} aria-label="放大画布" onClick={() => setView((v) => ({ ...v, k: Math.min(1.8, v.k * 1.2) }))}>
          ＋
        </button>
        <button type="button" className={btnGhost} aria-label="缩小画布" onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.2) }))}>
          －
        </button>
        <button type="button" className={btnGhost} onClick={() => setView({ x: 30, y: 24, k: 0.8 })}>
          重置视图
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-[var(--surface)] px-2.5 py-1.5 text-[11px] text-[var(--dim)]">
        拖动画布平移 · 滚轮/双指缩放 · 拖卡片标题栏移动卡片 · 点卡片上的按钮直接生成该镜真视频
      </p>
    </div>
  );
}

// ------------------------------------------------------------ shot card

const GEN_LABEL: Record<string, string> = {
  pending: "未生成",
  generating: "生成中",
  processing: "收片处理中",
  done: "已完成",
  failed: "失败",
};

function ShotCard({
  shot,
  data,
  pos,
  selected,
  onSelect,
  onDragStart,
  startJob,
  onNotice,
  stacked = false,
}: {
  shot: Shot;
  data: ProjectData;
  pos: { x: number; y: number };
  selected: boolean;
  onSelect: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  startJob: (kind: string, extra?: { shotId?: number; characterId?: number }) => void;
  onNotice: (n: { ok: boolean; text: string }) => void;
  stacked?: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: shot.title,
    durationSec: String(shot.durationSec),
    visual: shot.visual,
    dialogue: shot.dialogue,
    promptZh: shot.promptZh,
    startState: shot.startState,
    endState: shot.endState,
    characterIds: shot.characterIds,
  });
  useEffect(() => {
    setForm({
      title: shot.title,
      durationSec: String(shot.durationSec),
      visual: shot.visual,
      dialogue: shot.dialogue,
      promptZh: shot.promptZh,
      startState: shot.startState,
      endState: shot.endState,
      characterIds: shot.characterIds,
    });
  }, [shot.id, shot.title, shot.durationSec, shot.visual, shot.dialogue, shot.promptZh, shot.startState, shot.endState, shot.characterIds]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.updateShot({
        shotId: shot.id,
        title: form.title,
        durationSec: Number(form.durationSec) || shot.durationSec,
        visual: form.visual,
        dialogue: form.dialogue,
        promptZh: form.promptZh,
        startState: form.startState,
        endState: form.endState,
        characterIds: form.characterIds,
      }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });
  const delMut = useMutation({
    mutationFn: () => api.deleteShot({ shotId: shot.id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project"] }),
    onError: (e) => onNotice({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  const charNames = data.characters.filter((c) => shot.characterIds.includes(c.id)).map((c) => c.name);
  const statusColor =
    shot.genStatus === "done" && !shot.ready
      ? shot.qaStatus === "failed"
        ? "var(--bad)"
        : "var(--warn)"
      : shot.genStatus === "done"
        ? "var(--ok)"
        : shot.genStatus === "failed"
          ? "var(--bad)"
          : shot.genStatus === "pending"
            ? "var(--dim)"
            : "var(--warn)";
  const statusLabel =
    shot.genStatus === "done" && !shot.ready ? (shot.qaStatus === "failed" ? "硬验未过" : "待硬验") : GEN_LABEL[shot.genStatus];
  const busy = shot.genStatus === "generating" || shot.genStatus === "processing";
  const qaColor =
    shot.qaStatus === "passed"
      ? "var(--ok)"
      : shot.qaStatus === "failed"
        ? "var(--bad)"
        : "var(--warn)";
  const qaLabel =
    shot.qaStatus === "passed"
      ? "硬验通过"
      : shot.qaStatus === "failed"
        ? "硬验未通过"
        : shot.qaStatus === "checking"
          ? "抽帧硬验中"
          : "待硬验";

  return (
    <article
      data-card
      className={stacked ? "relative w-full rounded-xl border bg-[var(--surface)] shadow-lg" : "absolute rounded-xl border bg-[var(--surface)] shadow-lg"}
      style={
        stacked
          ? { borderColor: selected ? "var(--accent)" : "var(--border)" }
          : {
              left: pos.x,
              top: pos.y,
              width: CARD_W,
              borderColor: selected ? "var(--accent)" : "var(--border)",
              zIndex: selected ? 5 : 1,
            }
      }
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <header
        className="flex cursor-grab items-center gap-2 rounded-t-xl bg-[var(--surface2)] px-3 py-2 active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <span className="font-mono-num rounded bg-[var(--bg)] px-1.5 py-0.5 text-xs font-bold text-[var(--accent)]">
          镜 {String(shot.seq).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{shot.title || "未命名"}</span>
        <span className="font-mono-num text-xs text-[var(--dim)]">{shot.durationSec} 秒</span>
        <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ color: statusColor, border: `1px solid ${statusColor}` }}>
          {statusLabel}
        </span>
      </header>

      <div className="space-y-1.5 px-3 py-2.5 text-xs leading-5">
        {shot.videoUrl ? (
          <video src={shot.videoUrl} controls preload="metadata" className="aspect-[4/3] w-full rounded-lg bg-black object-contain" aria-label={`第 ${shot.seq} 镜视频预览`} />
        ) : null}
        {!editing ? (
          <>
            <p><span className="text-[var(--dim)]">画面：</span>{shot.visual || "（未填）"}</p>
            <p><span className="text-[var(--dim)]">台词/旁白：</span>{shot.dialogue || "（无）"}</p>
            <p><span className="text-[var(--dim)]">出场人物：</span>{charNames.length ? charNames.join("、") : "空镜 / 场景镜"}</p>
            <p className="line-clamp-3"><span className="text-[var(--dim)]">中文提示词：</span>{shot.promptZh || "（未填）"}</p>
            <p><span className="text-[var(--dim)]">开场状态：</span>{shot.startState || "（未填）"}</p>
            <p><span className="text-[var(--dim)]">结尾状态：</span>{shot.endState || "（未填）"}</p>
          </>
        ) : (
          <div className="space-y-1.5">
            {(
              [
                ["title", "标题", 1],
                ["durationSec", "时长（秒）", 1],
                ["visual", "画面描述", 2],
                ["dialogue", "台词 / 旁白", 2],
                ["promptZh", "中文提示词", 3],
                ["startState", "本镜开场状态", 2],
                ["endState", "本镜结尾状态", 2],
              ] as const
            ).map(([key, label, rows]) => (
              <div key={key}>
                <label className={labelCls} htmlFor={`shot-${shot.id}-${key}`}>{label}</label>
                <textarea
                  id={`shot-${shot.id}-${key}`}
                  className={inputCls}
                  rows={rows}
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                />
              </div>
            ))}
            <details>
              <summary className="cursor-pointer py-1 text-xs text-[var(--dim)]">手动调整出场人物（默认自动绑定，一般不用）</summary>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {data.characters.map((c) => {
                  const on = form.characterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="rounded-full border px-2 py-1 text-[11px]"
                      style={{
                        borderColor: on ? "var(--accent)" : "var(--border)",
                        color: on ? "var(--accent)" : "var(--dim)",
                      }}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          characterIds: on ? f.characterIds.filter((i) => i !== c.id) : [...f.characterIds, c.id],
                        }))
                      }
                    >
                      {c.tag}
                    </button>
                  );
                })}
                {data.characters.length === 0 && <span className="text-[11px] text-[var(--dim)]">角色棚还没有角色。</span>}
              </div>
            </details>
          </div>
        )}
        {shot.genStatus === "done" && (
          <div className="rounded-lg border px-2 py-1.5" style={{ borderColor: qaColor }}>
            <span className="font-semibold" style={{ color: qaColor }}>
              人物一致性硬验：{qaLabel}
            </span>
            {shot.qaStatus === "failed" && shot.qaAttempts > 0 && (
              <span className="text-[var(--dim)]">（已自动重生成 {shot.qaAttempts}/{shot.qaMaxAttempts} 次）</span>
            )}
            {shot.qaStatus === "failed" && shot.qaReason && <p className="mt-0.5 leading-5 text-[var(--bad)]">{shot.qaReason}</p>}
            {shot.qaStatus === "passed" && shot.qaReason && <p className="mt-0.5 leading-5 text-[var(--dim)]">{shot.qaReason}</p>}
            {!shot.ready && shot.qaStatus !== "failed" && (
              <p className="mt-0.5 leading-5 text-[var(--dim)]">抽帧逐人比对定妆锚图（含背景人物），通过前不能拼接。</p>
            )}
          </div>
        )}
        {shot.genStatus === "failed" && shot.failReason && (
          <p className="rounded-lg border border-[var(--bad)] px-2 py-1.5 leading-5 text-[var(--bad)]">{shot.failReason}</p>
        )}
        {shot.quotaExceeded && (
          <p className="text-[11px] leading-5 text-[var(--warn)]">这是额度用完导致的失败，请等额度恢复后再重试，不要反复点击。</p>
        )}
      </div>

      <footer className="flex flex-wrap gap-1.5 border-t border-[var(--border)] px-3 py-2">
        {shot.ready ? (
          <span className="rounded-lg bg-[var(--ok)] px-3 py-2 text-sm font-semibold text-[#14161a]">已生成 ✓ 硬验通过</span>
        ) : shot.genStatus === "done" && shot.qaStatus === "failed" ? (
          <button type="button" className={btnPrimary} onClick={() => startJob("gen_video", { shotId: shot.id })}>
            重新生成并硬验
          </button>
        ) : shot.genStatus === "done" ? (
          <>
            <button type="button" className={btnPrimary} disabled>
              {shot.qaStatus === "checking" ? "抽帧硬验中…" : "等待硬验…"}
            </button>
            <button type="button" className={btnGhost} onClick={() => startJob("verify_shot", { shotId: shot.id })}>
              立即硬验
            </button>
          </>
        ) : shot.genStatus === "failed" ? (
          <button type="button" className={btnPrimary} disabled={shot.quotaExceeded} onClick={() => startJob("gen_video", { shotId: shot.id })}>
            重试生成这一镜
          </button>
        ) : busy ? (
          <>
            <button type="button" className={btnPrimary} disabled>
              {shot.genStatus === "processing" ? "收片处理中…" : "生成中…"}
            </button>
            <button type="button" className={btnGhost} onClick={() => startJob("gen_video", { shotId: shot.id })}>
              卡住了？重新生成
            </button>
          </>
        ) : (
          <button type="button" className={btnPrimary} onClick={() => startJob("gen_video", { shotId: shot.id })}>
            生成真视频
          </button>
        )}
        {editing ? (
          <button type="button" className={btnGhost} onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            保存
          </button>
        ) : (
          <button type="button" className={btnGhost} onClick={() => setEditing(true)}>
            编辑
          </button>
        )}
        <button type="button" className={btnGhost} onClick={() => delMut.mutate()} disabled={delMut.isPending} aria-label={`删除第 ${shot.seq} 镜`}>
          删除
        </button>
      </footer>
    </article>
  );
}
