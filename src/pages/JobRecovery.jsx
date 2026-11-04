import { useCallback, useEffect, useRef, useState } from "react";
import { History, RefreshCw, ShieldCheck } from "lucide-react";
import { request, post, date } from "../api";
import { Badge, Button, Empty, ErrorBox, Json, Table } from "../components";
import { score } from "../view-utils";

export function JobRecovery({ ctx, job }) {
  const [snapshot, setSnapshot] = useState({ jobId: job.id, rows: [] });
  const checkpoints = snapshot.jobId === job.id ? snapshot.rows : [];
  const requestSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const simulated = !job.payload?.mode || job.payload.mode === "simulated";
  const stopped = ["interrupted", "failed", "cancelled"].includes(job.status);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await request(
        "/api/jobs/" + encodeURIComponent(job.id) + "/checkpoints",
      );
      if (!Array.isArray(result) && !Array.isArray(result.checkpoints))
        throw new Error("断点接口返回了无法识别的数据，请刷新后重试。");
      if (sequence === requestSequence.current)
        setSnapshot({
          jobId: job.id,
          rows: Array.isArray(result) ? result : result.checkpoints,
        });
    } catch (failure) {
      if (sequence === requestSequence.current) setError(failure);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [job.id]);
  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load, job.updatedAt, job.status]);
  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const next = await ctx.action(
        "resume-" + job.id,
        () => post("/api/jobs/" + encodeURIComponent(job.id) + "/resume", {}),
        "已创建继续评测任务；完成场景将按冻结条件复用。",
      );
      ctx.open("jobs", next.id || next.job?.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="job-recovery">
      <div className="section-toolbar">
        <div>
          <h3>已持久化的完成场景</h3>
          <p className="recovery-hint">
            断点保留已完成场景；继续评测前仍会校验冻结条件、原预算和未决请求。
          </p>
        </div>
        <div>
          <Button
            icon={RefreshCw}
            busy={loading}
            disabled={busy}
            onClick={load}
          >
            刷新断点
          </Button>
          {stopped && simulated && (
            <Button
              primary
              icon={History}
              busy={busy}
              disabled={!ctx.canEdit || loading || !checkpoints.length}
              onClick={resume}
            >
              继续未完成场景
            </Button>
          )}
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      {stopped && !simulated && (
        <div className="notice warning">
          <ShieldCheck size={17} />
          <p>
            真实工具执行不能直接从此处重发。请先核对外部业务状态，再创建明确的后续任务。
          </p>
        </div>
      )}
      {loading && !checkpoints.length ? (
        <div className="loading-line">正在读取完成场景…</div>
      ) : (
        <Table
          rows={checkpoints}
          columns={[
            {
              key: "caseId",
              label: "完成场景",
              render: (checkpoint) => (
                <div>
                  <strong>
                    {checkpoint.redacted ||
                    checkpoint.datasetPurpose === "holdout"
                      ? "封存验收场景"
                      : checkpoint.caseResult?.name || checkpoint.caseId}
                  </strong>
                  <small className="table-secondary">{checkpoint.caseId}</small>
                </div>
              ),
            },
            {
              key: "repeat",
              label: "重复序号",
              render: (checkpoint) => checkpoint.repeat ?? "—",
            },
            {
              key: "passed",
              label: "结果",
              render: (checkpoint) => (
                <Badge
                  value={checkpoint.caseResult?.passed ? "passed" : "rejected"}
                >
                  {checkpoint.caseResult?.passed ? "通过" : "未通过"}
                </Badge>
              ),
            },
            {
              key: "score",
              label: "评分",
              render: (checkpoint) => score(checkpoint.caseResult?.score),
            },
            {
              key: "completedAt",
              label: "持久化时间",
              render: (checkpoint) => date(checkpoint.completedAt),
            },
            {
              key: "details",
              label: "",
              render: (checkpoint) =>
                checkpoint.redacted ||
                checkpoint.datasetPurpose === "holdout" ? (
                  <span className="muted">
                    <ShieldCheck size={13} /> 仅摘要
                  </span>
                ) : (
                  <Json value={checkpoint.caseResult} label="查看完成记录" />
                ),
            },
          ]}
          empty={
            <Empty
              icon={History}
              title="尚无可复用的完成场景"
              text="用例完成后会持久化断点。没有断点时，需要重新创建评测任务。"
            />
          }
        />
      )}
    </section>
  );
}
