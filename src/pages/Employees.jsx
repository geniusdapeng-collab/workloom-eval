import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Code2,
  GitBranch,
  Plus,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { create } from "../api";
import { Badge, Button, Empty } from "../components";
import { matches, score } from "../view-utils";

export function Employees({ ctx }) {
  const { data, query, open, setDialog } = ctx;
  const list = data.employees.filter((r) => matches(r, query));
  return (
    <>
      <div className="section-toolbar">
        <span>
          <b>{data.employees.length}</b> 位数字员工{" "}
          <span className="muted">/ 以版本为评测单位</span>
        </span>
        <Button
          icon={GitBranch}
          disabled={!ctx.canEdit || !data.employees.length}
          onClick={() => ctx.createVersion()}
        >
          手动冻结版本
        </Button>
      </div>
      {!list.length ? (
        <Empty
          icon={Bot}
          title={query ? "没有匹配的员工" : "创建你的第一位数字员工"}
          text="用一句话描述岗位职责，平台将组合已有能力资产并列出缺口。"
          action={
            <Button
              primary
              icon={Plus}
              disabled={!ctx.canEdit}
              onClick={() => setDialog({ type: "create" })}
            >
              描述岗位需求
            </Button>
          }
        />
      ) : (
        <div className="employee-grid">
          {list.map((e, i) => {
            const vs = data.versions.filter((v) => v.employeeId === e.id),
              v = vs.find((x) => x.id === e.currentVersionId) || vs.at(-1),
              runs = data.runs.filter((r) =>
                vs.some((v) => v.id === r.versionId),
              ),
              last = runs.at(-1);
            return (
              <article className="employee-card" key={e.id}>
                <div className="employee-card-top">
                  <span className={"employee-avatar color-" + (i % 4)}>
                    <Bot size={27} />
                  </span>
                  <Badge value={e.status || "draft"} />
                  <button
                    className="icon-button"
                    aria-label={"查看" + e.name}
                    onClick={() => open("employees", e.id)}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
                <button
                  className="employee-title"
                  onClick={() => open("employees", e.id)}
                >
                  {e.name}
                </button>
                <p>{e.role || e.description}</p>
                <div className="employee-tags">
                  <span>
                    <BookOpen size={12} />
                    {v?.knowledgeIds?.length || 0} 知识
                  </span>
                  <span>
                    <Wrench size={12} />
                    {v?.toolIds?.length || 0} 工具
                  </span>
                  <span>
                    <Code2 size={12} />
                    {v?.skillIds?.length || 0} 技能
                  </span>
                </div>
                <div className="employee-stats">
                  <div>
                    <small>当前版本</small>
                    <strong>{v?.label || "待创建"}</strong>
                  </div>
                  <div>
                    <small>最近评分</small>
                    <strong className={last ? "cyan-text" : ""}>
                      {score(last?.metrics?.score)}
                      {last && <small> / 100</small>}
                    </strong>
                  </div>
                  <div>
                    <small>版本数量</small>
                    <strong>{vs.length}</strong>
                  </div>
                </div>
                <div className="employee-bottom">
                  <span>
                    <span className="mini-dot" />
                    {e.accessMode === "http" ? "外部员工 API" : "平台托管员工"}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => open("employees", e.id)}
                  >
                    打开员工
                    <ArrowRight size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="notice neutral">
        <ShieldCheck size={18} />
        <p>
          初始员工和参考场景不代表已经通过验收。首次评测后，平台会建立真实的能力基线。
        </p>
      </div>
    </>
  );
}
