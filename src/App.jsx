import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Bot,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  GitBranch,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  UsersRound,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import { request, post, create, update, remove, download, titles } from "./api";
import {
  Button,
  Empty,
  ErrorBox,
  Section,
  Json,
  Modal,
  FormDialog,
  CopyValue,
  JobProgress,
} from "./components";
import { fields, versionFields, jobFields } from "./forms";
import { matches } from "./view-utils";
import { Overview } from "./pages/Overview";
import { Employees } from "./pages/Employees";
import { Assets } from "./pages/Assets";
import { Datasets } from "./pages/Datasets";
import { Evaluations } from "./pages/Evaluations";
import { Iterations } from "./pages/Iterations";
import { Versions } from "./pages/Versions";
import { Teams } from "./pages/Teams";
import { Deployments } from "./pages/Deployments";
import { Training } from "./pages/Training";
import { Nodes } from "./pages/Nodes";
import { Settings } from "./pages/Settings";
import { Experiences } from "./pages/Experiences";
import { CreateEmployee, ExtraDialog, Login } from "./pages/Dialogs";
import { Detail } from "./pages/Detail";

const NAV = [
  {
    group: "工作空间",
    items: [
      ["overview", "总览", LayoutDashboard],
      ["employees", "数字员工", Bot],
      ["assets", "能力资产", Boxes],
      ["datasets", "仿真与测试集", FlaskConical],
    ],
  },
  {
    group: "评测与迭代",
    items: [
      ["evaluations", "评测工作台", Activity],
      ["iterations", "自动迭代", Workflow],
      ["versions", "版本与报告", GitBranch],
      ["teams", "班组与记忆", UsersRound],
    ],
  },
  {
    group: "进阶能力",
    items: [
      ["deployments", "影子与发布", Radar],
      ["training", "训练与微调", BrainCircuit],
      ["nodes", "私有执行节点", Network],
      ["experiences", "经验与版本组合", Layers3],
    ],
  },
];
const PAGE = {
  overview: ["工作空间总览", "让每一次改进，都有证据。"],
  employees: ["数字员工", "从用人需求出发，构建可评测、可迭代的岗位能力。"],
  assets: ["能力资产", "知识、工具与技能，组成数字员工的工作能力。"],
  datasets: ["仿真与测试集", "将业务任务变成可复位、有状态、可验收的场景。"],
  evaluations: ["评测工作台", "看见执行过程，追溯每个结果的依据。"],
  iterations: ["自动迭代", "定位失败、生成候选，在同一条件下验证改进。"],
  versions: ["版本与报告", "保留每个版本的来路、表现与适用范围。"],
  teams: ["班组与记忆", "评测协作交接、岗位记忆与持续任务。"],
  deployments: ["影子与发布", "先验证实际输入，再按策略交付和回退。"],
  training: ["训练与微调", "改进技能、准备训练数据，管理真实微调任务。"],
  nodes: ["私有执行节点", "把浏览器与受控脚本执行留在你的环境中。"],
  experiences: ["经验与版本组合", "沉淀有依据的方法，比较不同目标下的版本。"],
  settings: ["模型与平台设置", "管理真实模型连接、运行凭据与工作区信息。"],
  jobs: ["任务中心", "执行状态、预算消耗与失败原因始终可见。"],
};
const defaultData = Object.fromEntries(Object.keys(titles).map((k) => [k, []]));
const helpTexts = {
  knowledge: "发布新修订后，已有员工版本仍绑定旧快照。",
  tools: "为每个工具明确接入方式、环境和权限。",
  skills: "将工作方法写成可执行步骤与异常路径。",
};
export default function App() {
  const [data, setData] = useState({
    ...defaultData,
    settings: {},
    overview: {},
  });
  const [session, setSession] = useState(null),
    [auth, setAuth] = useState(true);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const [page, setPage] = useState(location.hash.slice(1) || "overview");
  const [query, setQuery] = useState(""),
    [mobile, setMobile] = useState(false);
  const [form, setForm] = useState(null),
    [dialog, setDialog] = useState(null),
    [detail, setDetail] = useState(null);
  const [toast, setToast] = useState(null),
    [refreshing, setRefreshing] = useState(false),
    [actionBusy, setActionBusy] = useState("");
  const searchRef = useRef(null),
    toastTimer = useRef(null),
    fileRef = useRef(null);
  const notify = useCallback((message, tone = "success") => {
    setToast({ message, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [s, b] = await Promise.all([
        request("/api/session"),
        request("/api/bootstrap"),
      ]);
      setSession(s);
      setData({
        ...defaultData,
        ...b,
        ...Object.fromEntries(
          Object.entries(b)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [
              k,
              v
                .slice()
                .sort((a, b) =>
                  String(a.createdAt || "").localeCompare(
                    String(b.createdAt || ""),
                  ),
                ),
            ]),
        ),
      });
      setAuth(true);
      setError(null);
    } catch (e) {
      if (e.status === 401) setAuth(false);
      else setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    reload();
    const interval = setInterval(() => reload(true), 4000);
    return () => clearInterval(interval);
  }, [reload]);
  useEffect(() => {
    const handle = () => {
      const p = location.hash.slice(1);
      if (PAGE[p]) setPage(p);
    };
    const keys = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    addEventListener("hashchange", handle);
    addEventListener("keydown", keys);
    return () => {
      removeEventListener("hashchange", handle);
      removeEventListener("keydown", keys);
      clearTimeout(toastTimer.current);
    };
  }, []);
  const navigate = useCallback((p) => {
    setPage(p);
    setQuery("");
    setMobile(false);
    location.hash = p;
  }, []);
  const closeForm = useCallback(() => setForm(null), []),
    closeDialog = useCallback(() => setDialog(null), []),
    closeDetail = useCallback(() => setDetail(null), []);
  const canEdit = ["admin", "editor"].includes(session?.role);
  async function action(key, fn, message) {
    setActionBusy(key);
    try {
      const result = await fn();
      await reload(true);
      if (message) notify(message);
      return result;
    } catch (e) {
      notify(e.message, "error");
      throw e;
    } finally {
      setActionBusy("");
    }
  }
  function editResource(kind, item) {
    setForm({
      title: (item ? "编辑" : "新建") + titles[kind],
      subtitle: helpTexts[kind],
      fields: fields(kind, data, item),
      initial: item
        ? { ...item, tags: (item.tags || []).join("，") }
        : undefined,
      wide: ["tools", "cases", "teams"].includes(kind),
      submit: (body) =>
        action(
          "save",
          () =>
            item
              ? update(kind, item.id, {
                  ...body,
                  expectedRevision: item.revision,
                })
              : create(kind, body),
          item ? "已保存新修订" : "已创建",
        ),
    });
  }
  async function runJob(type, payload) {
    const j = await post("/api/jobs", {
      type,
      payload,
      budgetTokens: payload.budgetTokens,
    });
    await reload(true);
    notify("任务已进入执行队列，结果将实时更新。");
    return j;
  }
  function jobForm(type, initial = {}) {
    const names = {
      evaluate: "启动评测",
      optimize: "创建自动迭代任务",
      team_evaluate: "评测班组协作",
      memory_evaluate: "评测岗位记忆",
      long_horizon: "长任务连续评测",
      fine_tune: "创建模型微调任务",
      skill_repair: "生成技能修复候选",
      shadow_evaluate: "启动影子评测",
      browser_evaluate: "提交浏览器评测",
    };
    setForm({
      title: names[type] || "创建任务",
      subtitle:
        type === "optimize"
          ? "优化器仅使用训练集或开发集；验证集独立评测，盲测内容不进入优化上下文。"
          : type === "fine_tune"
            ? "仅向明确支持微调的供应商提交。DeepSeek 默认配置不代表支持模型权重微调。"
            : "真实模型调用将消耗供应商额度。任务、用量和失败原因会保留。",
      fields: jobFields(type, data),
      initial,
      wide: true,
      submitLabel: "启动任务",
      submit: async (body) => {
        const j = await runJob(type, body);
        setDetail({ kind: "jobs", id: j.id || j.job?.id });
      },
    });
  }
  function createVersion(initial = {}) {
    setForm({
      title: "冻结新的员工版本",
      subtitle: "版本创建后不可修改；后续改动将生成新版本，并保留依赖快照。",
      fields: versionFields(data),
      initial,
      wide: true,
      submitLabel: "冻结版本",
      submit: async (body) => {
        const v = await post("/api/versions", body);
        await reload(true);
        notify("新版本已冻结，可以开始试岗评测。");
        setDetail({ kind: "versions", id: v.id || v.version?.id });
      },
    });
  }
  function confirmDelete(kind, item) {
    setDialog({ type: "delete", kind, item });
  }
  async function cancel(id) {
    setOperationError(null);
    try {
      await action(
        "cancel",
        () => post("/api/jobs/" + id + "/cancel", {}),
        "已请求取消；在途调用的最终状态将继续记录。",
      );
    } catch (failure) {
      setOperationError(failure);
    }
  }
  async function exportFile(path, name) {
    try {
      await download(path, name);
      notify("已导出文件");
    } catch (e) {
      notify(e.message, "error");
    }
  }
  const ctx = {
    data,
    session,
    page,
    query,
    canEdit,
    navigate,
    notify,
    reload,
    action,
    actionBusy,
    editResource,
    jobForm,
    runJob,
    createVersion,
    confirmDelete,
    exportFile,
    open: (kind, id) => setDetail({ kind, id }),
    setDialog,
    setForm,
    cancel,
  };
  const activeJobs = data.jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  if (!auth) return <Login onSuccess={() => reload()} />;
  if (loading)
    return (
      <div className="app-loading">
        <div className="brand-mark">
          <Layers3 size={28} />
        </div>
        <h1>
          秀吉<b>系统</b>
        </h1>
        <LoaderCircle size={22} className="spin" />
        <p>正在连接评测工作空间</p>
      </div>
    );
  return (
    <div className="app-shell">
      {mobile && (
        <div className="nav-backdrop" onClick={() => setMobile(false)} />
      )}
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <a
          href="#overview"
          className="brand"
          title="丰臣秀吉数字员工评测与迭代平台"
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          <span>
            秀吉<b>系统</b>
            <small>数字员工评测与迭代</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">秀</span>
          <div>
            <strong>
              {session?.workspaceName || session?.workspace || "默认工作空间"}
            </strong>
            <small>
              {session?.localMode ? "本地私有工作空间" : "团队工作空间"}
            </small>
          </div>
          <ShieldCheck size={15} />
        </div>
        <nav aria-label="平台导航">
          {NAV.map((group) => (
            <div className="nav-group" key={group.group}>
              <span className="nav-label">{group.group}</span>
              {group.items.map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={"nav-item " + (page === id ? "active" : "")}
                  onClick={() => navigate(id)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {id === "iterations" &&
                    activeJobs.some((j) => j.type === "optimize") && (
                      <i className="activity-dot" />
                    )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="model-mini">
            <span
              className={
                "connection-dot " + (data.settings?.modelConfigured ? "on" : "")
              }
            />
            <div>
              <strong>
                {data.settings?.modelConfigured
                  ? "真实模型已就绪"
                  : "模型待连接"}
              </strong>
              <small>DeepSeek · 独立调用回执</small>
            </div>
            <button
              className="icon-button"
              aria-label="配置模型"
              onClick={() => navigate("settings")}
            >
              <ArrowUpRight size={16} />
            </button>
          </div>
          <button
            className={"nav-item " + (page === "settings" ? "active" : "")}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            <span>模型与平台设置</span>
          </button>
          <div className="user">
            <span className="user-avatar">
              {(session?.user?.name ||
                session?.user?.email ||
                "W")[0].toUpperCase()}
            </span>
            <div>
              <strong>
                {session?.user?.name || session?.user?.email || "工作区管理员"}
              </strong>
              <small>
                {session?.role === "viewer"
                  ? "只读成员"
                  : session?.localMode
                    ? "本地可信会话"
                    : "工作区成员"}
              </small>
            </div>
            {!session?.localMode && (
              <button
                className="icon-button"
                aria-label="退出登录"
                onClick={async () => {
                  try {
                    await post("/api/auth/logout", {});
                    setAuth(false);
                  } catch (e) {
                    notify(e.message, "error");
                  }
                }}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{PAGE[page]?.[0] || "总览"}</strong>
          </div>
          <div className="header-actions">
            <label className="global-search">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="搜索当前页面"
                placeholder="搜索当前页面…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
            <button
              className="icon-button"
              onClick={() => reload()}
              aria-label="刷新数据"
              disabled={refreshing}
            >
              <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            </button>
            <button
              className={
                "icon-button notifications " +
                (page === "jobs" ? "selected" : "")
              }
              aria-label={"任务中心，" + activeJobs.length + "个进行中"}
              onClick={() => navigate("jobs")}
            >
              <Bell size={18} />
              {activeJobs.length > 0 && <i />}
            </button>
            <span className="header-divider" />
            <span className="live-label">
              <i />
              持久化工作空间
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">秀吉系统 / {page.toUpperCase()}</div>
              <h1>{PAGE[page]?.[0]}</h1>
              <p>{PAGE[page]?.[1]}</p>
            </div>
            <div className="page-actions">
              {page === "overview" || page === "employees" ? (
                <Button
                  primary
                  icon={Plus}
                  disabled={!canEdit}
                  onClick={() => setDialog({ type: "create" })}
                >
                  创建数字员工
                </Button>
              ) : page === "evaluations" ? (
                <Button
                  primary
                  icon={Plus}
                  disabled={!canEdit || !data.versions.length}
                  onClick={() => jobForm("evaluate")}
                >
                  启动评测
                </Button>
              ) : page === "iterations" ? (
                <Button
                  primary
                  icon={WandSparkles}
                  disabled={!canEdit || !data.versions.length}
                  onClick={() => jobForm("optimize")}
                >
                  创建迭代任务
                </Button>
              ) : null}
            </div>
          </div>
          {error && <ErrorBox error={error} retry={() => reload()} />}
          {operationError && <ErrorBox error={operationError} />}
          {page === "overview" && <Overview ctx={ctx} />}
          {page === "employees" && <Employees ctx={ctx} />}
          {page === "assets" && <Assets ctx={ctx} fileRef={fileRef} />}
          {page === "datasets" && <Datasets ctx={ctx} />}
          {page === "evaluations" && <Evaluations ctx={ctx} />}
          {page === "iterations" && <Iterations ctx={ctx} />}
          {page === "versions" && <Versions ctx={ctx} />}
          {page === "teams" && <Teams ctx={ctx} />}
          {page === "deployments" && <Deployments ctx={ctx} />}
          {page === "training" && <Training ctx={ctx} />}
          {page === "nodes" && <Nodes ctx={ctx} />}
          {page === "experiences" && <Experiences ctx={ctx} />}
          {page === "settings" && <Settings ctx={ctx} />}
          {page === "jobs" && (
            <Section
              title="全部任务"
              sub="状态来自持久化任务队列，执行与评分可能分别完成。"
            >
              {data.jobs
                .filter((j) => matches(j, query))
                .slice()
                .reverse()
                .map((j) => (
                  <JobProgress
                    key={j.id}
                    job={j}
                    onCancel={cancel}
                    onOpen={() => ctx.open("jobs", j.id)}
                  />
                ))}
              {!data.jobs.length && (
                <Empty
                  title="还没有运行任务"
                  text="从创建员工、评测或自动迭代开始。"
                />
              )}
            </Section>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} />
              版本可追溯 · 结果有依据 · 仿真与真实执行分明
            </span>
            <span>秀吉系统</span>
          </footer>
        </main>
      </div>
      {form && (
        <FormDialog
          key={form.title + (form.initial?.id || "")}
          config={form}
          onClose={closeForm}
        />
      )}
      {dialog?.type === "create" && (
        <CreateEmployee
          ctx={ctx}
          initial={dialog.initial}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "delete" && (
        <Modal title={"删除" + titles[dialog.kind]} onClose={closeDialog}>
          <div className="form-body">
            {dialog.error && <ErrorBox error={dialog.error} />}
            <p>
              将删除“{dialog.item.name || dialog.item.id}
              ”。已冻结版本和历史证据不会随此操作改写；被引用的资产可能被服务端拒绝删除。
            </p>
            <div className="modal-actions">
              <Button onClick={closeDialog}>取消</Button>
              <Button
                danger
                busy={actionBusy === "delete"}
                onClick={async () => {
                  try {
                    await action(
                      "delete",
                      () => remove(dialog.kind, dialog.item.id),
                      "已删除",
                    );
                    closeDialog();
                    closeDetail();
                  } catch (failure) {
                    setDialog((current) =>
                      current?.type === "delete"
                        ? { ...current, error: failure }
                        : current,
                    );
                  }
                }}
              >
                删除
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {dialog?.type === "token" && (
        <Modal
          title={dialog.rotated ? "节点凭据已轮换" : "私有节点注册凭据"}
          onClose={closeDialog}
        >
          <div className="form-body">
            <div className="notice">
              <ShieldCheck size={18} />
              <p>
                {dialog.rotated
                  ? "旧凭据已立即失效。新令牌仅展示一次，请更新私有节点的运行环境；关闭后无法再次查看。"
                  : "此令牌仅展示一次。请在你的私有节点运行环境中使用，不要写入仓库。"}
              </p>
            </div>
            <pre className="token-value">{dialog.token}</pre>
            <CopyValue value={dialog.token || ""} label="复制节点令牌" />
            <Json value={dialog.node} label="节点信息" />
            <div className="modal-actions">
              <Button primary onClick={closeDialog}>
                已保存，关闭
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {dialog && ["team", "result", "audit"].includes(dialog.type) && (
        <ExtraDialog ctx={ctx} dialog={dialog} onClose={closeDialog} />
      )}
      {detail && !form && !dialog && (
        <Detail ctx={ctx} detail={detail} onClose={closeDetail} />
      )}
      {toast && (
        <div
          className={"toast " + toast.tone}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "error" ? (
            <X size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{toast.message}</span>
          <button aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
