import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Boxes,
  ChevronRight,
  FileCheck2,
  FlaskConical,
  Gauge,
  GitBranch,
  Sparkles,
  Workflow,
  Wrench,
} from "lucide-react";
import { create, num, date } from "../api";
import { Button, Empty, Metric, Section, JobProgress } from "../components";
import { metric, rate } from "../view-utils";
import { RunTable } from "./RunTable";

export function Overview({ ctx }) {
  const { data, open, navigate, setDialog, cancel } = ctx;
  const runs = data.runs,
    latest = runs
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
  const active = data.jobs.filter((j) =>
    ["running", "queued"].includes(j.status),
  );
  const versions = data.versions.length;
  return (
    <>
      <div className="overview-hero">
        <div className="hero-copy">
          <span className="hero-kicker">
            <Sparkles size={14} />
            从需求到经过验证的员工
          </span>
          <h2>
            把岗位需求，变成
            <br />
            <em>持续进化的数字员工。</em>
          </h2>
          <p>
            装配知识、工具与技能，在业务仿真中试岗。
            <br className="desktop-br" />
            用真实评测驱动下一版本，而每一步都有据可查。
          </p>
          <div className="hero-actions">
            <Button
              primary
              icon={Sparkles}
              disabled={!ctx.canEdit}
              onClick={() => setDialog({ type: "create" })}
            >
              描述你的用人需求
              <ArrowRight size={16} />
            </Button>
            <button
              className="text-button"
              onClick={() => navigate("evaluations")}
            >
              进入评测工作台
              <ArrowUpRight size={15} />
            </button>
          </div>
        </div>
        <div
          className="hero-visual"
          aria-label="需求、员工版本、评测和迭代形成闭环"
        >
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit-core">
            <Bot size={35} />
            <span>EMPLOYEE</span>
          </div>
          <span className="orbit-node node-one">
            <BookOpen size={17} />
            知识库
          </span>
          <span className="orbit-node node-two">
            <Wrench size={17} />
            工具与技能
          </span>
          <span className="orbit-node node-three">
            <FileCheck2 size={17} />
            评测证据
          </span>
          <span className="orbit-node node-four">
            <GitBranch size={17} />
            迭代版本
          </span>
          <i className="orbit-point" />
        </div>
      </div>
      <div className="metrics-grid">
        <Metric
          label="数字员工"
          value={num(data.employees.length)}
          sub={versions + " 个冻结版本"}
          icon={Bot}
        />
        <Metric
          label="评测运行"
          value={num(runs.length)}
          sub={runs.length ? "每次结果保留执行依据" : "首次试岗后建立能力基线"}
          icon={Activity}
          accent="cyan"
        />
        <Metric
          label="最近任务通过率"
          value={rate(metric(latest, "passRate"))}
          sub={
            latest
              ? num(metric(latest, "valid")) +
                " 个有效样本 · " +
                date(latest.createdAt)
              : "尚未评测，不显示估算分数"
          }
          icon={Gauge}
          accent="green"
        />
        <Metric
          label="进行中的任务"
          value={num(active.length)}
          sub={
            data.jobs.filter((j) => j.status === "completed").length +
            " 个任务已完成"
          }
          icon={Workflow}
          accent="amber"
        />
      </div>
      <div className="dashboard-columns">
        <Section
          title="从这里开始"
          sub="四步建立第一个可迭代的岗位"
          action={<span className="subtle-label">完整工作流</span>}
        >
          <div className="getting-started">
            {[
              [
                Bot,
                "01",
                "创建岗位",
                "描述员工要解决的问题，自动生成初版。",
                () => setDialog({ type: "create" }),
              ],
              [
                Boxes,
                "02",
                "装配能力",
                "绑定有依据的知识、真实工具和技能。",
                () => navigate("assets"),
              ],
              [
                FlaskConical,
                "03",
                "仿真试岗",
                "设置业务状态和验收规则，建立基线。",
                () => navigate("evaluations"),
              ],
              [
                GitBranch,
                "04",
                "驱动迭代",
                "比较候选的改善和退化，形成版本建议。",
                () => navigate("iterations"),
              ],
            ].map(([Icon, n, title, desc, fn]) => (
              <button className="start-step" key={n} onClick={fn}>
                <span className="step-icon">
                  <Icon size={19} />
                </span>
                <span>
                  <small>{n}</small>
                  <strong>{title}</strong>
                  <p>{desc}</p>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        </Section>
        <Section
          title="运行动态"
          sub="真实任务状态与执行进度"
          action={
            <button className="text-button" onClick={() => navigate("jobs")}>
              全部任务
              <ArrowUpRight size={14} />
            </button>
          }
        >
          {data.jobs.length ? (
            data.jobs
              .slice(-4)
              .reverse()
              .map((j) => (
                <JobProgress
                  key={j.id}
                  job={j}
                  onCancel={cancel}
                  onOpen={() => open("jobs", j.id)}
                />
              ))
          ) : (
            <Empty
              icon={Activity}
              title="工作空间已就绪"
              text="创建员工或启动评测后，执行动态会显示在这里。"
            />
          )}
        </Section>
      </div>
      <Section
        title="最近评测"
        sub="每份结果绑定员工版本、测试集与模型配置"
        action={
          <button
            className="text-button"
            onClick={() => navigate("evaluations")}
          >
            查看工作台
            <ArrowUpRight size={14} />
          </button>
        }
      >
        <RunTable ctx={ctx} rows={runs.slice(-5).reverse()} />
      </Section>
    </>
  );
}
