import { Empty, JobProgress } from "../components";

export function JobList({ ctx, types }) {
  const rows = ctx.data.jobs
    .filter((j) => types.includes(j.type))
    .slice()
    .reverse();
  return rows.length ? (
    <div className="job-list">
      {rows.map((j) => (
        <JobProgress
          key={j.id}
          job={j}
          onCancel={ctx.cancel}
          onOpen={() => ctx.open("jobs", j.id)}
        />
      ))}
    </div>
  ) : (
    <Empty
      title="暂无相关任务"
      text="任务启动后，可在这里跟踪进度和查看真实结果。"
    />
  );
}
