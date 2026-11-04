import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  CheckCircle2,
  CircleHelp,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  FileCheck2,
  FlaskConical,
  GitBranch,
  ShieldCheck,
  Trash2,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import { post, pretty, num, date, titles, statuses } from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Progress,
  Table,
  Json,
  Modal,
  CopyValue,
  FactList,
} from "../components";
import { fields, options } from "../forms";
import { asArray, score, rate, recordName } from "../view-utils";
import { JobRecovery } from "./JobRecovery";

export function Detail({ ctx, detail, onClose }) {
  const [operationError, setOperationError] = useState(null);
  useEffect(() => {
    setOperationError(null);
  }, [detail.kind, detail.id]);
  const item = (ctx.data[detail.kind] || []).find((r) => r.id === detail.id);
  if (!item)
    return (
      <Modal title="记录详情" onClose={onClose}>
        <Empty
          title="记录暂不可用"
          text="请刷新后重试；记录可能已删除或不在当前权限范围内。"
        />
      </Modal>
    );
  const { kind } = detail;
  const mutable = [
    "employees",
    "knowledge",
    "tools",
    "skills",
    "models",
    "datasets",
    "cases",
    "teams",
    "memories",
    "experiences",
  ].includes(kind);
  const vs =
    kind === "employees"
      ? ctx.data.versions.filter((v) => v.employeeId === item.id)
      : [];
  const v = vs.find((v) => v.id === item.currentVersionId) || vs.at(-1);
  return (
    <Modal
      title={item.name || item.title || item.label || titles[kind]}
      subtitle={titles[kind] + " · " + item.id}
      wide
      onClose={onClose}
    >
      {kind === "runs" ? (
        <RunDetail ctx={ctx} run={item} />
      ) : (
        <div className="detail-body">
          {operationError && <ErrorBox error={operationError} />}
          {kind === "employees" && (
            <>
              <div className="detail-hero">
                <span className="employee-avatar">
                  <Bot size={30} />
                </span>
                <div>
                  <h3>{item.role || item.name}</h3>
                  <p>{item.description}</p>
                </div>
                <Badge value={item.status} />
              </div>
              <div className="detail-actions">
                <Button
                  primary
                  icon={Activity}
                  disabled={!ctx.canEdit || !v}
                  onClick={() => ctx.jobForm("evaluate", { versionId: v?.id })}
                >
                  试岗评测
                </Button>
                <Button
                  icon={GitBranch}
                  disabled={!ctx.canEdit}
                  onClick={() =>
                    ctx.createVersion(
                      v
                        ? {
                            ...v,
                            parentId: v.id,
                            label: "V" + (vs.length + 1),
                            changeSummary: "",
                          }
                        : { employeeId: item.id },
                    )
                  }
                >
                  创建新版本
                </Button>
                {v && (
                  <Button
                    icon={WandSparkles}
                    disabled={!ctx.canEdit}
                    onClick={() => ctx.jobForm("optimize", { versionId: v.id })}
                  >
                    自动迭代
                  </Button>
                )}
              </div>
              <FactList
                entries={[
                  [
                    "接入方式",
                    item.accessMode === "http" ? "外部 HTTP 员工" : "平台托管",
                  ],
                  ["当前版本", v?.label],
                  ["真实模型", recordName("models", v?.modelId, ctx.data)],
                  ["创建时间", date(item.createdAt)],
                ]}
              />
              <h3>岗位需求</h3>
              <pre className="prose-pre">
                {item.requirements || item.description || "未记录需求"}
              </pre>
              <h3>能力资产</h3>
              <AssetSummary ctx={ctx} version={v} />
              <h3>版本谱系</h3>
              <Table
                rows={vs.slice().reverse()}
                onRow={(v) => ctx.open("versions", v.id)}
                columns={[
                  { key: "label", label: "版本" },
                  { key: "changeSummary", label: "改动说明" },
                  {
                    key: "createdAt",
                    label: "创建时间",
                    render: (v) => date(v.createdAt),
                  },
                ]}
              />
            </>
          )}
          {kind === "versions" && (
            <>
              <div className="detail-actions">
                <Badge value={item.status || "ready"} />
                <Button
                  primary
                  icon={Activity}
                  disabled={!ctx.canEdit}
                  onClick={() =>
                    ctx.jobForm("evaluate", { versionId: item.id })
                  }
                >
                  评测此版本
                </Button>
                <Button
                  icon={WandSparkles}
                  disabled={!ctx.canEdit}
                  onClick={() =>
                    ctx.jobForm("optimize", { versionId: item.id })
                  }
                >
                  自动迭代
                </Button>
                <Button
                  icon={Download}
                  onClick={() =>
                    ctx.exportFile(
                      "/api/versions/" + item.id + "/export",
                      "员工版本-" + item.label + ".json",
                    )
                  }
                >
                  导出能力包
                </Button>
              </div>
              <FactList
                entries={[
                  ["员工", recordName("employees", item.employeeId, ctx.data)],
                  ["父版本", recordName("versions", item.parentId, ctx.data)],
                  ["模型", recordName("models", item.modelId, ctx.data)],
                  ["依赖摘要", <code>{item.manifestHash || "—"}</code>],
                  ["改动说明", item.changeSummary],
                ]}
              />
              <h3>岗位指令</h3>
              <pre className="prose-pre">{item.prompt}</pre>
              <h3>绑定能力</h3>
              <AssetSummary ctx={ctx} version={item} />
              <Json value={item.policy} label="权限与执行策略" open />
              <Json
                value={item.manifest || item.snapshots || item}
                label="冻结版本清单"
              />
            </>
          )}
          {kind === "jobs" && (
            <>
              <div className="detail-actions">
                <Badge value={item.status} />
                <span className="muted">创建于 {date(item.createdAt)}</span>
                {["running", "queued"].includes(item.status) && (
                  <Button danger onClick={() => ctx.cancel(item.id)}>
                    取消任务
                  </Button>
                )}
              </div>
              {["running", "queued"].includes(item.status) && (
                <Progress
                  value={
                    typeof item.progress === "number"
                      ? item.progress
                      : item.progress?.percent || 0
                  }
                  label={item.progress?.message || "任务执行中"}
                />
              )}{" "}
              {item.error && (
                <ErrorBox
                  error={
                    typeof item.error === "string"
                      ? new Error(item.error)
                      : item.error
                  }
                />
              )}
              <FactList
                entries={[
                  ["任务类型", item.type],
                  ["Token 预算", num(item.budgetTokens)],
                  ["已用 Token", num(item.usedTokens)],
                  ["更新时间", date(item.updatedAt)],
                ]}
              />
              {item.result && (
                <>
                  <h3>任务结果</h3>
                  <div className="detail-actions">
                    {item.result.employeeId && (
                      <Button
                        onClick={() =>
                          ctx.open("employees", item.result.employeeId)
                        }
                      >
                        打开员工
                        <ArrowUpRight size={14} />
                      </Button>
                    )}
                    {item.result.runId && (
                      <Button
                        primary
                        onClick={() => ctx.open("runs", item.result.runId)}
                      >
                        查看评测证据
                      </Button>
                    )}
                    {item.result.reportId && (
                      <Button
                        onClick={() =>
                          ctx.open("reports", item.result.reportId)
                        }
                      >
                        查看报告
                      </Button>
                    )}
                    {item.result.optimizationId && (
                      <Button
                        onClick={() =>
                          ctx.open("optimizations", item.result.optimizationId)
                        }
                      >
                        查看迭代结果
                      </Button>
                    )}
                    {item.result.bestVersionId && (
                      <Button
                        onClick={() =>
                          ctx.open("versions", item.result.bestVersionId)
                        }
                      >
                        打开最佳候选
                      </Button>
                    )}
                  </div>
                  {item.result.gaps?.length > 0 && (
                    <div className="notice warning">
                      <CircleHelp size={18} />
                      <div>
                        <strong>需要补齐的能力缺口</strong>
                        <ul>
                          {item.result.gaps.map((g, i) => (
                            <li key={i}>
                              {typeof g === "string" ? g : pretty(g)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  <Json value={item.result} label="完整任务结果" open />
                </>
              )}
              {item.type === "evaluate" && <JobRecovery ctx={ctx} job={item} />}
              <Json value={item.payload} label="运行参数" />
            </>
          )}
          {kind === "reports" && <ReportDetail ctx={ctx} report={item} />}
          {kind === "optimizations" && (
            <>
              <FactList
                entries={[
                  [
                    "基线",
                    recordName("versions", item.baselineVersionId, ctx.data),
                  ],
                  [
                    "最佳候选",
                    recordName("versions", item.bestVersionId, ctx.data),
                  ],
                  ["停止原因", item.stopReason || "未结束"],
                ]}
              />
              <h3>候选版本与比较</h3>
              <Table
                rows={item.candidates || []}
                rowKey="versionId"
                columns={[
                  {
                    key: "versionId",
                    label: "候选",
                    render: (c) => (
                      <button
                        className="text-button"
                        onClick={() => ctx.open("versions", c.versionId)}
                      >
                        {recordName("versions", c.versionId, ctx.data)}
                        <ArrowUpRight size={13} />
                      </button>
                    ),
                  },
                  { key: "round", label: "轮次" },
                  {
                    key: "score",
                    label: "评分",
                    render: (c) => score(c.score ?? c.metrics?.score),
                  },
                  {
                    key: "accepted",
                    label: "筛选",
                    render: (c) =>
                      c.accepted === true
                        ? "入选"
                        : c.accepted === false
                          ? "未入选"
                          : c.status || "已记录",
                  },
                  {
                    key: "reason",
                    label: "原因",
                    render: (c) => c.reason || c.changeSummary || "—",
                  },
                ]}
              />
              <Json value={item.rounds} label="逐轮依据" />
              <Json value={item} label="完整迭代记录" />
            </>
          )}
          {kind === "knowledge" && (
            <>
              <FactList
                entries={[
                  ["来源", item.source],
                  ["修订", item.version || item.revision],
                  ["发布", item.published ? "可引用" : "未发布"],
                  ["模型出域", item.allowedModelEgress ? "允许" : "受限"],
                ]}
              />
              <h3>知识正文</h3>
              <pre className="prose-pre">{item.content}</pre>
            </>
          )}
          {kind === "tools" && (
            <>
              <FactList
                entries={[
                  ["接入方式", item.adapter],
                  ["环境", statuses[item.mode] || item.mode],
                  ["动作", item.operation],
                  ["用途", item.description],
                ]}
              />
              <Button
                primary
                icon={Activity}
                disabled={!ctx.canEdit}
                busy={ctx.actionBusy === item.id}
                onClick={async () => {
                  setOperationError(null);
                  try {
                    const r = await ctx.action(
                      item.id,
                      () => post("/api/tools/" + item.id + "/test", {}),
                      "工具探测完成",
                    );
                    ctx.setDialog({
                      type: "result",
                      title: "工具连接探测",
                      value: r,
                    });
                  } catch (failure) {
                    setOperationError(failure);
                  }
                }}
              >
                探测工具连接
              </Button>
              <Json value={item.inputSchema} label="输入结构" open />
              <Json value={item.outputSchema} label="输出结构" />
              <Json value={item.config} label="连接配置" />
              <Json value={item.permissions} label="权限" />
            </>
          )}
          {kind === "skills" && (
            <>
              <p>{item.description}</p>
              <pre className="prose-pre">{item.content}</pre>
              <div className="skill-steps">
                {asArray(item.steps).map((s, i) => (
                  <div key={i}>
                    <span>{i + 1}</span>
                    <p>
                      {typeof s === "string"
                        ? s
                        : s.name || s.description || s.action || pretty(s)}
                    </p>
                  </div>
                ))}
              </div>
              <Json value={item} label="技能清单" />
            </>
          )}
          {kind === "cases" && (
            <>
              {item.hidden ? (
                <div className="notice">
                  <ShieldCheck size={19} />
                  <p>该用例细节已隔离。此页面仅展示授权可见的元数据。</p>
                </div>
              ) : (
                <>
                  <FactList
                    entries={[
                      [
                        "测试集",
                        recordName("datasets", item.datasetId, ctx.data),
                      ],
                      ["场景类型", item.category],
                    ]}
                  />
                  <h3>任务输入</h3>
                  <pre className="prose-pre">{item.input}</pre>
                  <h3>预期行为</h3>
                  <pre className="prose-pre">{item.expected}</pre>
                  <Json value={item.initialState} label="初始业务状态" open />
                  <Json value={item.assertions} label="验收断言" open />
                  <Json value={item.fault} label="故障注入" />
                </>
              )}
            </>
          )}
          {![
            "employees",
            "versions",
            "jobs",
            "reports",
            "optimizations",
            "knowledge",
            "tools",
            "skills",
            "cases",
          ].includes(kind) && (
            <>
              <FactList
                entries={[
                  ["创建时间", date(item.createdAt)],
                  ["更新时间", date(item.updatedAt)],
                  ["修订", item.revision],
                ]}
              />
              <Json value={item} label="完整记录" open />
            </>
          )}
          {kind === "experiences" &&
            item.approved &&
            item.visibility === "shared" && (
              <Button
                icon={Download}
                disabled={!ctx.canEdit}
                onClick={async () => {
                  setOperationError(null);
                  try {
                    await ctx.action(
                      "reuse",
                      () => post("/api/experiences/" + item.id + "/import", {}),
                      "已创建待复核的经验副本",
                    );
                  } catch (failure) {
                    setOperationError(failure);
                  }
                }}
              >
                创建复用副本
              </Button>
            )}
          {mutable && !(kind === "cases" && item.hidden) && (
            <div className="detail-actions bottom">
              <Button
                disabled={!ctx.canEdit || (kind === "cases" && item.hidden)}
                onClick={() => ctx.editResource(kind, item)}
              >
                编辑{titles[kind]}
              </Button>
              <Button
                icon={Trash2}
                danger
                disabled={!ctx.canEdit}
                onClick={() => ctx.confirmDelete(kind, item)}
              >
                删除
              </Button>
              <CopyValue value={item.id} label="复制标识" />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function AssetSummary({ ctx, version }) {
  return (
    <div className="asset-summary">
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
          {version?.[key]?.length ? (
            version[key].map((id) => (
              <button
                className="asset-link"
                key={id}
                onClick={() => ctx.open(kind, id)}
              >
                {recordName(kind, id, ctx.data)}
                <ArrowUpRight size={12} />
              </button>
            ))
          ) : (
            <small>未绑定</small>
          )}
        </div>
      ))}
    </div>
  );
}

export function ReportDetail({ ctx, report }) {
  const run = ctx.data.runs.find((r) => r.id === report.runId),
    metrics = report.metrics || run?.metrics || {};
  return (
    <>
      <div className="detail-actions">
        <Badge
          value={
            typeof report.recommendation === "string"
              ? report.recommendation
              : report.recommendation?.status
          }
        />
        <Button
          primary
          icon={Activity}
          disabled={!run}
          onClick={() => ctx.open("runs", run.id)}
        >
          查看执行证据
        </Button>
        <Button
          icon={Download}
          onClick={() =>
            ctx.exportFile(
              "/api/reports/" + report.id + "/export?format=markdown",
              "评测报告-" + report.id + ".md",
            )
          }
        >
          Markdown
        </Button>
        <Button
          icon={Download}
          onClick={() =>
            ctx.exportFile(
              "/api/reports/" + report.id + "/export?format=json",
              "评测报告-" + report.id + ".json",
            )
          }
        >
          JSON
        </Button>
        <Button
          icon={ExternalLink}
          onClick={() =>
            ctx.exportFile(
              "/api/reports/" + report.id + "/export?format=html",
              "评测报告-" + report.id + ".html",
            )
          }
        >
          HTML
        </Button>
      </div>
      <div className="report-score">
        <div>
          <span>本次评测评分</span>
          <strong>
            {score(metrics.score)}
            <small>/ 100</small>
          </strong>
        </div>
        <div>
          <span>任务通过率</span>
          <strong>{rate(metrics.passRate)}</strong>
        </div>
        <div>
          <span>有效样本</span>
          <strong>
            {metrics.valid ?? "—"}
            <small>/ {metrics.total ?? "—"}</small>
          </strong>
        </div>
        <div>
          <span>关键违规</span>
          <strong className={metrics.violations ? "red-text" : ""}>
            {metrics.violations ?? "—"}
          </strong>
        </div>
      </div>
      {Number.isFinite(metrics.costUSD) && (
        <div className="notice neutral">
          <Cpu size={17} />
          <p>
            模型调用估算成本：<strong>{num(metrics.costUSD, 6)} USD</strong>
            。按配置费率与实际 Token 计算，属于估算，不是供应商账单。
          </p>
        </div>
      )}
      <h3>评测结论</h3>
      <pre className="prose-pre">
        {typeof report.summary === "string"
          ? report.summary
          : pretty(report.summary || {})}
      </pre>
      <h3>推荐与使用范围</h3>
      <pre className="prose-pre">
        {pretty(report.recommendation || "尚未形成推荐结论")}
      </pre>
      <h3>限制与未覆盖</h3>
      <pre className="prose-pre">{pretty(report.limitations || [])}</pre>
      {report.comparison && (
        <>
          <h3>基线比较</h3>
          <Json value={report.comparison} label="改善与退化" open />
        </>
      )}
      {report.suggestions && (
        <>
          <h3>下一轮建议</h3>
          <pre className="prose-pre">{pretty(report.suggestions)}</pre>
        </>
      )}
      <Json value={report} label="完整报告记录" />
    </>
  );
}

export function RunDetail({ ctx, run }) {
  const [selected, setSelected] = useState(0),
    [onlyFailed, setOnlyFailed] = useState(false);
  const rows = (run.caseResults || []).filter((r) => !onlyFailed || !r.passed),
    current = rows[selected] || rows[0];
  const review = () =>
    ctx.setForm({
      title: "提交用例复核意见",
      subtitle: "意见单独留痕，原始模型输出与断言结果保留。",
      fields: [
        {
          key: "decision",
          label: "复核结论",
          type: "select",
          required: true,
          options: [
            { value: "approved", label: "认可原判定" },
            { value: "rejected", label: "原判定存在问题" },
            { value: "uncertain", label: "需要进一步核验" },
          ],
        },
        { key: "reason", label: "复核依据", type: "textarea", required: true },
      ],
      submit: (body) =>
        ctx.action(
          "review",
          () =>
            post("/api/reviews", {
              runId: run.id,
              caseId: current.caseId,
              ...body,
            }),
          "复核意见已记录",
        ),
    });
  return (
    <div className="run-detail">
      <div className="run-banner">
        <div>
          <Badge value={run.status} />
          <strong>{recordName("versions", run.versionId, ctx.data)}</strong>
          <span>{recordName("datasets", run.datasetId, ctx.data)}</span>
        </div>
        <div className="mode-tags">
          <span>
            <Cpu size={13} />
            {run.modelMode === "real" ? "真实模型" : run.modelMode || "未标记"}
          </span>
          <span>
            <FlaskConical size={13} />
            {statuses[run.toolMode] || run.toolMode || "未标记"}
          </span>
        </div>
      </div>
      <div className="run-summary">
        <span>
          综合评分 <strong>{score(run.metrics?.score)}</strong>
        </span>
        <span>
          通过率 <strong>{rate(run.metrics?.passRate)}</strong>
        </span>
        <span>
          有效样本{" "}
          <strong>
            {run.metrics?.valid ?? "—"}/{run.metrics?.total ?? "—"}
          </strong>
        </span>
        <span>
          Token <strong>{num(run.metrics?.tokens)}</strong>
        </span>
      </div>
      <div className="evidence-layout">
        <aside className="case-list">
          <div className="case-list-header">
            <strong>场景用例</strong>
            <label>
              <input
                type="checkbox"
                checked={onlyFailed}
                onChange={(e) => {
                  setOnlyFailed(e.target.checked);
                  setSelected(0);
                }}
              />
              仅未通过
            </label>
          </div>
          {rows.map((r, i) => (
            <button
              className={current === r ? "active" : ""}
              key={r.caseId + "-" + i}
              onClick={() => setSelected(i)}
            >
              {r.passed ? (
                <CheckCircle2 size={17} className="green-text" />
              ) : (
                <span className="failed-mark">!</span>
              )}
              <span>
                <strong>{r.name || "用例 " + (i + 1)}</strong>
                <small>
                  {r.status === "failed"
                    ? "执行失败"
                    : r.passed
                      ? "通过"
                      : "未通过"}{" "}
                  · {num(r.latencyMs)} ms
                </small>
              </span>
              <b>{score(r.score)}</b>
            </button>
          ))}
          {!rows.length && <Empty title="暂无符合条件的用例" />}
        </aside>
        <section className="execution-column">
          <div className="column-heading">
            <Activity size={16} />
            <h3>员工执行</h3>
            {current && <span>{asArray(current.steps).length} 个步骤</span>}
          </div>
          {current ? (
            <>
              <div className="message user-message">
                <span className="message-avatar">U</span>
                <div>
                  <small>任务输入</small>
                  <p>{current.input || "该用例输入未公开"}</p>
                </div>
              </div>
              {asArray(current.steps).map((step, i) => (
                <div className="trace-step" key={i}>
                  <span className="trace-line" />
                  <span className="trace-icon">
                    {/tool/.test(step.type || step.role || "") ? (
                      <Wrench size={14} />
                    ) : (
                      <Cpu size={14} />
                    )}
                  </span>
                  <div>
                    <div className="trace-heading">
                      <strong>
                        {step.toolName ||
                          step.tool ||
                          step.name ||
                          step.type ||
                          step.role ||
                          "执行步骤"}
                      </strong>
                      <small>
                        {step.latencyMs ? num(step.latencyMs) + " ms" : ""}
                      </small>
                    </div>
                    {(step.content || step.output || step.message) && (
                      <p>
                        {typeof (
                          step.content ||
                          step.output ||
                          step.message
                        ) === "string"
                          ? step.content || step.output || step.message
                          : pretty(step.content || step.output || step.message)}
                      </p>
                    )}
                    <Json value={step} label="查看调用与回执" />
                  </div>
                </div>
              ))}
              <div className="message employee-message">
                <span className="message-avatar">
                  <Bot size={16} />
                </span>
                <div>
                  <small>最终交付</small>
                  <pre>
                    {typeof current.output === "string"
                      ? current.output
                      : pretty(current.output || {})}
                  </pre>
                </div>
              </div>
              {current.error && (
                <ErrorBox
                  error={
                    typeof current.error === "string"
                      ? new Error(current.error)
                      : current.error
                  }
                />
              )}
            </>
          ) : (
            <Empty title="选择一个场景查看执行过程" />
          )}
        </section>
        <aside className="verdict-column">
          <div className="column-heading">
            <FileCheck2 size={16} />
            <h3>验收与诊断</h3>
          </div>
          {current && (
            <>
              <div className="verdict-score">
                <span>当前用例</span>
                <strong>{score(current.score)}</strong>
                <Badge
                  value={
                    current.passed
                      ? "passed"
                      : current.status === "failed"
                        ? "failed"
                        : "rejected"
                  }
                />
              </div>
              <h4>业务验收断言</h4>
              <div className="assertion-list">
                {asArray(current.assertions).map((a, i) => (
                  <div key={i}>
                    {a.passed || a.pass ? (
                      <CheckCircle2 size={15} className="green-text" />
                    ) : (
                      <X size={15} className="red-text" />
                    )}
                    <span>
                      {a.message ||
                        a.description ||
                        a.type ||
                        "断言 " + (i + 1)}
                      <small>{a.path || ""}</small>
                    </span>
                  </div>
                ))}
              </div>
              {current.judge && (
                <>
                  <h4>语义裁判依据</h4>
                  <pre className="prose-pre">{pretty(current.judge)}</pre>
                </>
              )}
              {asArray(current.violations).length > 0 && (
                <div className="notice warning">
                  <ShieldCheck size={16} />
                  <p>
                    {current.violations
                      .map((v) => (typeof v === "string" ? v : pretty(v)))
                      .join("；")}
                  </p>
                </div>
              )}
              <Json value={current.finalState} label="最终业务状态" />
              <Json value={current.usage} label="调用用量" />
              <Button disabled={!ctx.canEdit} onClick={review}>
                提交人工复核
              </Button>
            </>
          )}
        </aside>
      </div>
      <div className="run-manifest">
        <Json value={run.manifest} label="冻结的评测条件与资产摘要" />
      </div>
    </div>
  );
}
