import { useState } from "react";
import { date } from "../api";
import { Badge, Empty, Section, Tabs, Table, JobProgress } from "../components";
import { matches, recordName } from "../view-utils";
import { RunTable } from "./RunTable";

export function Evaluations({ ctx }) {
  const [tab, setTab] = useState("runs");
  return (
    <>
      <Tabs
        tabs={[
          { id: "runs", label: "评测运行", count: ctx.data.runs.length },
          {
            id: "jobs",
            label: "执行队列",
            count: ctx.data.jobs.filter((j) => j.type === "evaluate").length,
          },
          { id: "reviews", label: "人工复核", count: ctx.data.reviews.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "runs" && (
        <Section title="评测运行记录" sub="模型真实调用 · 环境模式逐次记录">
          <RunTable
            ctx={ctx}
            rows={ctx.data.runs
              .filter((r) =>
                matches(
                  { ...r, name: recordName("versions", r.versionId, ctx.data) },
                  ctx.query,
                ),
              )
              .slice()
              .reverse()}
          />
        </Section>
      )}
      {tab === "jobs" && (
        <Section title="执行与评分进度">
          {ctx.data.jobs
            .filter((j) => j.type === "evaluate")
            .slice()
            .reverse()
            .map((j) => (
              <JobProgress
                key={j.id}
                job={j}
                onCancel={ctx.cancel}
                onOpen={() => ctx.open("jobs", j.id)}
              />
            ))}
          {!ctx.data.jobs.some((j) => j.type === "evaluate") && (
            <Empty title="暂无评测任务" />
          )}
        </Section>
      )}
      {tab === "reviews" && (
        <Section
          title="人工复核记录"
          sub="复核意见单独保存，不改写原始执行事实。"
        >
          <Table
            rows={ctx.data.reviews}
            columns={[
              { key: "runId", label: "运行" },
              { key: "caseId", label: "用例" },
              {
                key: "decision",
                label: "结论",
                render: (r) => <Badge value={r.decision} />,
              },
              { key: "reason", label: "依据" },
              {
                key: "createdAt",
                label: "时间",
                render: (r) => date(r.createdAt),
              },
            ]}
          />
        </Section>
      )}
    </>
  );
}
