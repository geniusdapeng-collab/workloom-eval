import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Code2,
  Layers3,
  LoaderCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { request, post, create, date } from "../api";
import { Button, ErrorBox, Table, Json, Modal } from "../components";

export function CreateEmployee({ ctx, initial, onClose }) {
  const [requirements, setRequirements] = useState(initial || ""),
    [name, setName] = useState(""),
    [modelId, setModelId] = useState(ctx.data.models[0]?.id || "");
  const [selected, setSelected] = useState({
      knowledgeIds: [],
      toolIds: [],
      skillIds: [],
    }),
    [advanced, setAdvanced] = useState(false),
    [autoEvaluate, setAutoEvaluate] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const templates = [
    [
      "售后客服",
      "我需要一位售后客服，回答退换货问题、查询订单并处理符合政策的退款。超过500元交主管确认，不承诺政策外的补偿。回复简洁、友好。",
    ],
    [
      "经营分析师",
      "我需要一位经营分析师，根据业务数据库分析经营变化。核验指标口径，说明数据缺失，输出有来源依据的分析报告，不能编造数据。",
    ],
    [
      "内容运营",
      "我需要一位内容运营员工，根据品牌资料与素材生产内容，检查事实、素材依据和交付格式。在仿真环境验证发布，遇到失败不能重复提交。",
    ],
  ];
  async function submit(e) {
    e.preventDefault();
    if (!requirements.trim() || !modelId) {
      setError(new Error("请描述岗位需求并选择已配置的真实模型。"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const j = await ctx.runJob("create_employee", {
        name: name.trim() || undefined,
        requirements,
        modelId,
        ...(advanced ? selected : {}),
        autoEvaluate,
      });
      onClose();
      ctx.open("jobs", j.id || j.job?.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="你需要一位怎样的数字员工？"
      subtitle="描述工作目标，平台将匹配能力资产，生成初始员工版本与试岗场景。"
      onClose={busy ? () => {} : onClose}
      wide
    >
      <form className="form-body create-wizard" onSubmit={submit}>
        {error && <ErrorBox error={error} />}
        <div className="wizard-progress">
          <span className="active">
            <b>1</b>描述岗位
          </span>
          <i />
          <span>
            <b>2</b>生成能力配置
          </span>
          <i />
          <span>
            <b>3</b>冻结初版与试岗
          </span>
        </div>
        <label className="field">
          <span>
            岗位需求 <b>*</b>
          </span>
          <textarea
            rows={6}
            autoFocus
            value={requirements}
            disabled={busy}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="例如：我需要一个售后客服，能查询订单、判断退换货政策……请说明目标、工作范围、资料来源，以及需要人工处理的事项。"
          />
        </label>
        <div className="template-row">
          <span>试试这些岗位</span>
          {templates.map(([label, text]) => (
            <button
              type="button"
              disabled={busy}
              key={label}
              onClick={() => setRequirements(text)}
            >
              {label}
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            <span>
              员工名称 <small>可选，由系统生成</small>
            </span>
            <input
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：售后服务专员"
            />
          </label>
          <label className="field">
            <span>
              真实模型 <b>*</b>
            </span>
            <select
              value={modelId}
              disabled={busy}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">选择模型</option>
              {ctx.data.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="advanced-toggle"
          onClick={() => setAdvanced((v) => !v)}
        >
          <Settings2 size={15} />
          指定可使用的能力资产 <span>{advanced ? "收起" : "展开"}</span>
        </button>
        {advanced && (
          <div className="asset-bindings">
            {[
              ["knowledgeIds", "knowledge", "知识库", BookOpen],
              ["toolIds", "tools", "工具", Wrench],
              ["skillIds", "skills", "技能", Code2],
            ].map(([key, kind, label, Icon]) => (
              <div key={key}>
                <h4>
                  <Icon size={15} />
                  {label}
                </h4>
                {ctx.data[kind].length ? (
                  ctx.data[kind].map((r) => (
                    <label className="asset-check" key={r.id}>
                      <input
                        type="checkbox"
                        checked={selected[key].includes(r.id)}
                        onChange={(e) =>
                          setSelected((v) => ({
                            ...v,
                            [key]: e.target.checked
                              ? [...v[key], r.id]
                              : v[key].filter((id) => id !== r.id),
                          }))
                        }
                      />
                      <span>{r.name}</span>
                    </label>
                  ))
                ) : (
                  <small>尚无可绑定资产；平台会列出缺口。</small>
                )}
              </div>
            ))}
          </div>
        )}
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={autoEvaluate}
            disabled={busy}
            onChange={(e) => setAutoEvaluate(e.target.checked)}
          />
          <span>
            初版生成后，自动启动仿真试岗
            <small>
              使用生成的开发用例；结果作为初步基线，独立验收另行执行。
            </small>
          </span>
        </label>
        <div className="notice neutral">
          <ShieldCheck size={18} />
          <p>
            系统仅引用当前工作区获准使用的资产。缺少业务知识、接口或权限时，会明确列出缺口，不会生成虚假的业务成功。
          </p>
        </div>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            primary
            icon={Sparkles}
            busy={busy}
            disabled={!ctx.canEdit || !requirements.trim() || !modelId}
          >
            生成员工初始版本
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TeamWizard({ ctx, onClose }) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [memoryPolicy, setMemoryPolicy] = useState("isolated");
  const [members, setMembers] = useState([
      { employeeId: "", versionId: "", task: "" },
    ]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const change = (i, key, value) =>
    setMembers((ms) =>
      ms.map((m, n) =>
        n === i
          ? {
              ...m,
              [key]: value,
              ...(key === "employeeId" ? { versionId: "" } : {}),
            }
          : m,
      ),
    );
  async function submit(e) {
    e.preventDefault();
    if (
      !name.trim() ||
      !description.trim() ||
      members.some((m) => !m.employeeId || !m.versionId || !m.task.trim())
    ) {
      setError(
        new Error("请填写名称、共同目标，并为每位成员选择版本和交接职责。"),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await create("teams", { name, description, memoryPolicy, members });
      await ctx.reload(true);
      ctx.notify("协作班组已创建");
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="创建员工协作班组"
      subtitle="每位成员绑定冻结版本，明确各步骤的输入、职责和交付要求。"
      onClose={busy ? () => {} : onClose}
      wide
    >
      <form className="form-body" onSubmit={submit}>
        {error && <ErrorBox error={error} />}
        <div className="form-grid">
          <label className="field">
            <span>班组名称 *</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>记忆策略</span>
            <select
              value={memoryPolicy}
              onChange={(e) => setMemoryPolicy(e.target.value)}
            >
              <option value="isolated">成员隔离，仅显式交接</option>
              <option value="shared">班组任务内共享</option>
            </select>
          </label>
          <label className="field full">
            <span>共同目标与完成要求 *</span>
            <textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </label>
        </div>
        <h3>成员与工作顺序</h3>
        {members.map((m, i) => (
          <div className="member-editor" key={i}>
            <b>{i + 1}</b>
            <label className="field">
              <span>员工</span>
              <select
                required
                value={m.employeeId}
                onChange={(e) => change(i, "employeeId", e.target.value)}
              >
                <option value="">选择员工</option>
                {ctx.data.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>冻结版本</span>
              <select
                required
                value={m.versionId}
                onChange={(e) => change(i, "versionId", e.target.value)}
              >
                <option value="">选择版本</option>
                {ctx.data.versions
                  .filter((v) => v.employeeId === m.employeeId)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field member-task">
              <span>职责与交付</span>
              <input
                required
                value={m.task}
                onChange={(e) => change(i, "task", e.target.value)}
                placeholder="例如：核验数据并交付指标表"
              />
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="移除成员"
              disabled={members.length <= 1}
              onClick={() => setMembers((ms) => ms.filter((_, n) => n !== i))}
            >
              <X size={17} />
            </button>
          </div>
        ))}
        <Button
          type="button"
          icon={Plus}
          onClick={() =>
            setMembers((ms) => [
              ...ms,
              { employeeId: "", versionId: "", task: "" },
            ])
          }
        >
          增加成员
        </Button>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" primary busy={busy}>
            创建班组
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ExtraDialog({ ctx, dialog, onClose }) {
  const [events, setEvents] = useState(null),
    [error, setError] = useState(null);
  useEffect(() => {
    if (dialog.type === "audit")
      request("/api/events")
        .then((r) => setEvents(Array.isArray(r) ? r : r.events || []))
        .catch(setError);
  }, [dialog.type]);
  if (dialog.type === "team") return <TeamWizard ctx={ctx} onClose={onClose} />;
  if (dialog.type === "result")
    return (
      <Modal title={dialog.title} onClose={onClose}>
        <div className="form-body">
          <Json value={dialog.value} label="真实调用回执" open />
          <div className="modal-actions">
            <Button primary onClick={onClose}>
              完成
            </Button>
          </div>
        </div>
      </Modal>
    );
  if (dialog.type === "audit")
    return (
      <Modal
        title="工作区审计事件"
        subtitle="事件只增不改，密钥和原始推理内容不会进入审计。"
        onClose={onClose}
        wide
      >
        <div className="form-body">
          {error ? (
            <ErrorBox error={error} />
          ) : events ? (
            <Table
              rows={events.slice().reverse()}
              columns={[
                { key: "kind", label: "事件" },
                { key: "subjectId", label: "对象" },
                {
                  key: "createdAt",
                  label: "时间",
                  render: (e) => date(e.createdAt),
                },
                {
                  key: "data",
                  label: "记录",
                  render: (e) => <Json value={e.data} label="查看" />,
                },
              ]}
            />
          ) : (
            <div className="loading-line">
              <LoaderCircle className="spin" size={19} />
              加载审计事件
            </div>
          )}
        </div>
      </Modal>
    );
  return null;
}

export function Login({ onSuccess }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  return (
    <div className="login-screen">
      <div className="login-card">
        <span className="brand-mark">
          <Layers3 size={25} />
        </span>
        <h1>
          WorkLoom <b>Eval</b>
        </h1>
        <p>登录数字员工评测工作空间</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await post("/api/auth/login", { email, password });
              await onSuccess();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <ErrorBox error={error} />}
          <label className="field">
            <span>邮箱</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button primary busy={busy} type="submit">
            登录工作空间
            <ArrowRight size={16} />
          </Button>
        </form>
        <small>账户由工作区管理员配置，数据按工作区隔离。</small>
      </div>
    </div>
  );
}
