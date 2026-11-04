import React, { useEffect, useRef, useState } from "react";
import {
  X,
  LoaderCircle,
  AlertCircle,
  Inbox,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  CheckCircle2,
  Clock3,
  XCircle,
  Download,
} from "lucide-react";
import { pretty, statuses, date, num } from "./api";

export function Badge({ value, children, tone }) {
  const kind =
    tone ||
    (/^(completed|ready|active|connected|passed|succeeded|approved|online|recommended)$/.test(
      value || "",
    )
      ? "green"
      : /failed|rejected|blocked/.test(value || "")
        ? "red"
        : /running|queued|pending|draft|interrupted|limited/.test(value || "")
          ? "amber"
          : "neutral");
  return (
    <span className={"badge " + kind}>
      <span className="status-dot" />
      {children || statuses[value] || value || "待评测"}
    </span>
  );
}
export function Button({
  children,
  icon: Icon,
  primary,
  danger,
  busy,
  className = "",
  ...props
}) {
  return (
    <button
      className={
        "button " +
        (primary ? "primary " : "") +
        (danger ? "danger " : "") +
        className
      }
      {...props}
      disabled={props.disabled || busy}
    >
      {busy ? (
        <LoaderCircle size={16} className="spin" />
      ) : Icon ? (
        <Icon size={16} />
      ) : null}
      {children}
    </button>
  );
}
export function Empty({
  icon: Icon = Inbox,
  title = "这里还没有记录",
  text = "完成配置后，真实运行结果会显示在这里。",
  action,
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function ErrorBox({ error, retry }) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{error?.message || String(error)}</strong>
        {error?.code && <small>{error.code}</small>}
      </div>
      {retry && <Button onClick={retry}>重试</Button>}
    </div>
  );
}
export function Progress({ value = 0, label }) {
  return (
    <div className="progress-wrap">
      <div className="progress-label">
        <span>{label || "执行进度"}</span>
        <strong>{Math.round(value)}%</strong>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={label || "执行进度"}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: Math.min(100, Math.max(0, value)) + "%" }} />
      </div>
    </div>
  );
}
export function Metric({ label, value, sub, icon: Icon, accent = "purple" }) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {Icon && <Icon size={17} />}
      </div>
      <div className={"metric-value " + accent}>{value}</div>
      <div className="metric-sub">{sub}</div>
    </div>
  );
}
export function Section({ title, sub, action, children, className = "" }) {
  return (
    <section className={"panel " + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={value === t.id ? "active" : ""}
          key={t.id}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <small>{t.count}</small>}
        </button>
      ))}
    </div>
  );
}
export function Table({
  columns,
  rows,
  rowKey = "id",
  onRow,
  empty,
  selected,
}) {
  if (!rows.length) return empty || <Empty />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row[rowKey] || i}
              className={
                (onRow ? "clickable " : "") +
                (selected === row[rowKey] ? "selected" : "")
              }
              onClick={onRow ? () => onRow(row) : undefined}
              tabIndex={onRow ? 0 : undefined}
              aria-label={
                onRow
                  ? "查看 " +
                    (row.name || row.label || row.title || row[rowKey])
                  : undefined
              }
              onKeyDown={
                onRow
                  ? (event) => {
                      if (
                        event.target === event.currentTarget &&
                        ["Enter", " "].includes(event.key)
                      ) {
                        event.preventDefault();
                        onRow(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : (row[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Json({ value, label = "结构化详情", open = false }) {
  return (
    <details className="json-details" open={open || undefined}>
      <summary>
        {label}
        <ChevronDown size={14} />
      </summary>
      <pre>{pretty(value)}</pre>
    </details>
  );
}
export function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const handle = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const els = ref.current?.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handle);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={ref}
        className={"modal " + (wide ? "wide" : "")}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function FormDialog({ config, onClose }) {
  const [values, setValues] = useState(config.initial || {});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  function fieldValue(f) {
    const v = values[f.key] ?? f.default;
    return f.type === "json"
      ? typeof v === "string"
        ? v
        : pretty(v ?? (f.array ? [] : {}))
      : f.type === "checkbox"
        ? !!v
        : f.type === "multi"
          ? v || []
          : (v ?? "");
  }
  async function submit(e) {
    e.preventDefault();
    const body = {};
    const validation = {};
    for (const f of config.fields) {
      let v = fieldValue(f);
      if (f.required && (!String(v).trim() || (Array.isArray(v) && !v.length)))
        validation[f.key] = "请填写" + f.label;
      if (f.type === "number") {
        v = v === "" ? undefined : Number(v);
        if (
          v !== undefined &&
          (!Number.isFinite(v) ||
            (f.min !== undefined && v < f.min) ||
            (f.max !== undefined && v > f.max))
        )
          validation[f.key] = "请输入范围内的数值";
      }
      if (f.type === "json") {
        try {
          v = JSON.parse(v);
          if (f.array && !Array.isArray(v))
            validation[f.key] = "需要 JSON 数组";
        } catch {
          validation[f.key] = "JSON 格式不正确";
        }
      }
      if (f.type === "tags")
        v = String(v)
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
      if (f.type === "url" && v) {
        try {
          if (!["http:", "https:"].includes(new URL(v).protocol))
            validation[f.key] = "请输入 HTTP 或 HTTPS 地址";
        } catch {
          validation[f.key] = "请输入有效地址";
        }
      }
      body[f.key] = v;
    }
    setErrors(validation);
    if (Object.keys(validation).length) return;
    setBusy(true);
    setError(null);
    try {
      await config.submit(body);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={config.title}
      subtitle={config.subtitle}
      onClose={busy ? () => {} : onClose}
      wide={config.wide}
    >
      <form onSubmit={submit} className="form-body">
        {error && <ErrorBox error={error} />}
        <div className="form-grid">
          {config.fields.map((f) => (
            <div
              className={
                "field " +
                (f.wide || ["textarea", "json", "multi"].includes(f.type)
                  ? "full"
                  : "")
              }
              key={f.key}
            >
              <span>
                {f.label}
                {f.required && <b> *</b>}
              </span>
              {f.type === "select" ? (
                <select
                  aria-label={f.label}
                  aria-invalid={Boolean(errors[f.key])}
                  value={fieldValue(f)}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                  disabled={busy || f.disabled}
                >
                  <option value="">请选择</option>
                  {(f.options || []).map((o) => (
                    <option key={o.value ?? o.id} value={o.value ?? o.id}>
                      {o.label ?? o.name}
                    </option>
                  ))}
                </select>
              ) : f.type === "multi" ? (
                <div
                  className="multi-options"
                  role="group"
                  aria-label={f.label}
                >
                  {!f.options?.length && (
                    <small>暂无可绑定资产，请先在能力资产中创建。</small>
                  )}
                  {(f.options || []).map((o) => (
                    <label key={o.value ?? o.id}>
                      <input
                        type="checkbox"
                        checked={fieldValue(f).includes(o.value ?? o.id)}
                        disabled={busy}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            [f.key]: e.target.checked
                              ? [...fieldValue(f), o.value ?? o.id]
                              : fieldValue(f).filter(
                                  (id) => id !== (o.value ?? o.id),
                                ),
                          }))
                        }
                      />
                      {o.label ?? o.name}
                    </label>
                  ))}
                </div>
              ) : f.type === "checkbox" ? (
                <div className="checkbox-field">
                  <input
                    aria-label={f.label}
                    type="checkbox"
                    checked={fieldValue(f)}
                    disabled={busy}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.checked }))
                    }
                  />
                  <small>{f.checkLabel || "启用"}</small>
                </div>
              ) : ["textarea", "json"].includes(f.type) ? (
                <textarea
                  aria-label={f.label}
                  aria-invalid={Boolean(errors[f.key])}
                  className={f.type === "json" ? "code-input" : ""}
                  rows={f.rows || (f.type === "json" ? 6 : 4)}
                  value={fieldValue(f)}
                  placeholder={f.placeholder}
                  disabled={busy}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              ) : (
                <input
                  aria-label={f.label}
                  aria-invalid={Boolean(errors[f.key])}
                  type={
                    f.type === "number"
                      ? "number"
                      : f.type === "password"
                        ? "password"
                        : f.type === "url"
                          ? "url"
                          : "text"
                  }
                  autoComplete={
                    f.type === "password" ? "new-password" : undefined
                  }
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={fieldValue(f)}
                  placeholder={f.placeholder}
                  disabled={busy || f.disabled}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              )}{" "}
              {f.help && <small>{f.help}</small>}
              {errors[f.key] && (
                <small className="field-error">{errors[f.key]}</small>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button primary type="submit" busy={busy}>
            {config.submitLabel || "保存"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function CopyValue({ value, label = "复制" }) {
  const [done, setDone] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <Button
        icon={done ? Check : Copy}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            setError("复制失败，请手动选择下方内容。");
          }
        }}
      >
        {done ? "已复制" : label}
      </Button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
export function JobProgress({ job, onCancel, onOpen }) {
  const p =
    typeof job.progress === "object"
      ? (job.progress.percent ?? 0)
      : (job.progress ?? 0);
  return (
    <div className="job-line">
      <div className="job-indicator">
        {job.status === "running" ? (
          <LoaderCircle size={19} className="spin" />
        ) : job.status === "completed" ? (
          <CheckCircle2 size={19} />
        ) : job.status === "failed" ? (
          <XCircle size={19} />
        ) : (
          <Clock3 size={19} />
        )}
      </div>
      <div className="job-main">
        <div>
          <button className="text-button" onClick={onOpen}>
            {job.name ||
              {
                create_employee: "创建员工初始版本",
                evaluate: "执行评测",
                optimize: "自动迭代",
                team_evaluate: "班组协作评测",
                fine_tune: "模型微调",
                poll_training: "查询训练进度",
                memory_evaluate: "岗位记忆评测",
                shadow_evaluate: "影子评测",
                browser_evaluate: "浏览器评测",
                skill_repair: "技能修复",
                long_horizon: "长任务评测",
                knowledge_regression: "知识更新影响回归",
                benchmark_portfolio: "版本组合对比评测",
                reconcile_deployment: "核对部署结果",
              }[job.type] ||
              job.type}
          </button>
          <Badge value={job.status} />
        </div>
        <small>
          {job.progress?.message || job.message || date(job.createdAt)}
        </small>
        {["running", "queued"].includes(job.status) && (
          <div className="progress small">
            <i style={{ width: p + "%" }} />
          </div>
        )}
      </div>
      {["running", "queued"].includes(job.status) && (
        <Button onClick={() => onCancel(job.id)} className="small-button">
          取消
        </Button>
      )}
      {job.status === "completed" && (
        <button className="icon-button" aria-label="查看结果" onClick={onOpen}>
          <ArrowUpRight size={17} />
        </button>
      )}
    </div>
  );
}
export function FactList({ entries }) {
  return (
    <dl className="fact-list">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
