import {
  Clock3,
  GitCompareArrows,
  ShieldCheck,
  WandSparkles,
  Workflow,
} from "lucide-react";
import { Button, Empty, Section, Table, JobProgress } from "../components";
import { matches, recordName } from "../view-utils";

export function Iterations({ ctx }) {
  const { data } = ctx,
    active = data.jobs.filter(
      (j) => j.type === "optimize" && ["queued", "running"].includes(j.status),
    );
  return (
    <>
      <div className="info-strip">
        <Workflow size={23} />
        <div>
          <strong>由评测证据驱动每一轮改进</strong>
          <p>基线 → 失败诊断 → 受限补丁 → 候选版本 → 同条件回归 → 独立验证</p>
        </div>
        <span className="pill">不改权限与验收标准</span>
      </div>
      {active.length > 0 && (
        <Section title="正在迭代">
          {active.map((j) => (
            <JobProgress
              key={j.id}
              job={j}
              onCancel={ctx.cancel}
              onOpen={() => ctx.open("jobs", j.id)}
            />
          ))}
        </Section>
      )}
      <Section
        title="迭代任务"
        sub="保留所有候选，包含未改善、退化和未完成的版本"
      >
        <Table
          rows={data.optimizations
            .filter((o) => matches(o, ctx.query))
            .slice()
            .reverse()}
          onRow={(r) => ctx.open("optimizations", r.id)}
          columns={[
            {
              key: "employeeId",
              label: "员工",
              render: (r) => recordName("employees", r.employeeId, data),
            },
            {
              key: "baselineVersionId",
              label: "基线",
              render: (r) => recordName("versions", r.baselineVersionId, data),
            },
            {
              key: "bestVersionId",
              label: "当前最佳候选",
              render: (r) => recordName("versions", r.bestVersionId, data),
            },
            {
              key: "rounds",
              label: "轮次",
              render: (r) =>
                Array.isArray(r.rounds) ? r.rounds.length : r.rounds || 0,
            },
            {
              key: "candidates",
              label: "候选数",
              render: (r) => (r.candidates || []).length,
            },
            {
              key: "stopReason",
              label: "停止原因",
              render: (r) => r.stopReason || "处理中",
            },
          ]}
          empty={
            <Empty
              icon={WandSparkles}
              title="启动第一轮自动迭代"
              text="系统将围绕失败证据提出改动，生成真实候选版本并比较收益和退化。"
              action={
                <Button
                  primary
                  disabled={!ctx.canEdit || !data.versions.length}
                  onClick={() => ctx.jobForm("optimize")}
                >
                  创建迭代任务
                </Button>
              }
            />
          }
        />
      </Section>
      <Section title="迭代约束">
        <div className="principle-grid">
          {[
            [
              ShieldCheck,
              "边界固定",
              "优化器不能扩大权限、修改红线或读取盲测答案。",
            ],
            [
              GitCompareArrows,
              "比较同条件",
              "员工、测试集、环境和评分器修订共同构成比较依据。",
            ],
            [
              Clock3,
              "有明确停止点",
              "达到目标、无改善、预算耗尽或取消时，保留完整结果。",
            ],
          ].map(([Icon, t, p]) => (
            <div key={t}>
              <Icon size={21} />
              <strong>{t}</strong>
              <p>{p}</p>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
