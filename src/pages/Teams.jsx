import { useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  History,
  Plus,
  UsersRound,
} from "lucide-react";
import { date } from "../api";
import { Badge, Button, Empty, Section, Tabs, Table } from "../components";
import { matches, recordName } from "../view-utils";
import { JobList } from "./JobList";

export function Teams({ ctx }) {
  const [tab, setTab] = useState("teams");
  return (
    <>
      <Tabs
        tabs={[
          { id: "teams", label: "员工班组", count: ctx.data.teams.length },
          {
            id: "memories",
            label: "岗位记忆",
            count: ctx.data.memories.length,
          },
          { id: "long", label: "长任务评测" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "teams" && (
        <>
          <div className="section-toolbar">
            <span className="muted">职责分工、显式交接与记忆隔离</span>
            <div>
              <Button
                icon={Activity}
                disabled={!ctx.canEdit || !ctx.data.teams.length}
                onClick={() => ctx.jobForm("team_evaluate")}
              >
                评测班组
              </Button>
              <Button
                primary
                icon={Plus}
                disabled={!ctx.canEdit}
                onClick={() => ctx.setDialog({ type: "team" })}
              >
                创建班组
              </Button>
            </div>
          </div>
          <div className="employee-grid">
            {ctx.data.teams.map((t) => (
              <article className="employee-card" key={t.id}>
                <span className="employee-avatar color-1">
                  <UsersRound size={26} />
                </span>
                <h3>{t.name}</h3>
                <p>{t.description}</p>
                <div className="team-members">
                  {(t.members || []).map((m, i) => (
                    <span key={i}>
                      <Bot size={14} />
                      {recordName("employees", m.employeeId, ctx.data)}
                      <small>{m.task}</small>
                    </span>
                  ))}
                </div>
                <div className="employee-bottom">
                  <span>
                    {t.memoryPolicy === "shared"
                      ? "任务内共享记忆"
                      : "成员记忆隔离"}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => ctx.open("teams", t.id)}
                  >
                    查看配置
                    <ArrowRight size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!ctx.data.teams.length && (
            <Empty
              icon={UsersRound}
              title="构建一个协作班组"
              text="为每位员工分配步骤与交付要求，验证交接是否可靠。"
              action={
                <Button
                  primary
                  disabled={!ctx.canEdit}
                  onClick={() => ctx.setDialog({ type: "team" })}
                >
                  创建班组
                </Button>
              }
            />
          )}
        </>
      )}
      {tab === "memories" && (
        <Section
          title="有来源、有作用域的岗位记忆"
          sub="跨员工、跨租户的记忆不会默认共享。"
          action={
            <div className="inline-actions">
              <Button
                disabled={!ctx.canEdit || !ctx.data.versions.length}
                onClick={() => ctx.jobForm("memory_evaluate")}
              >
                验证记忆边界
              </Button>
              <Button
                primary
                icon={Plus}
                disabled={!ctx.canEdit}
                onClick={() => ctx.editResource("memories")}
              >
                添加记忆
              </Button>
            </div>
          }
        >
          <Table
            rows={ctx.data.memories.filter((m) => matches(m, ctx.query))}
            onRow={(m) => ctx.open("memories", m.id)}
            columns={[
              {
                key: "employeeId",
                label: "员工",
                render: (m) => recordName("employees", m.employeeId, ctx.data),
              },
              {
                key: "content",
                label: "记忆内容",
                render: (m) => <span className="clamp-two">{m.content}</span>,
              },
              { key: "scope", label: "作用域" },
              {
                key: "approved",
                label: "状态",
                render: (m) => (
                  <Badge
                    value={
                      m.expiresAt && new Date(m.expiresAt) < new Date()
                        ? "inactive"
                        : m.approved
                          ? "approved"
                          : "draft"
                    }
                  />
                ),
              },
              {
                key: "expiresAt",
                label: "失效时间",
                render: (m) => (m.expiresAt ? date(m.expiresAt) : "未设置"),
              },
            ]}
          />
        </Section>
      )}
      {tab === "long" && (
        <Section
          title="连续任务与长期记忆评测"
          sub="按顺序执行多个输入，检查任务接续、信息保持和作用域边界。"
        >
          <div className="feature-intro">
            <History size={36} />
            <h3>让员工完成一段工作，而非一轮回答</h3>
            <p>
              指定员工、冻结版本、任务序列与记忆作用域。结果记录各阶段产物及边界检查，不将独立任务的记忆自动串用。
            </p>
            <Button
              primary
              disabled={!ctx.canEdit || !ctx.data.versions.length}
              onClick={() => ctx.jobForm("long_horizon")}
            >
              创建连续任务评测
            </Button>
          </div>
          <JobList
            ctx={ctx}
            types={["long_horizon", "memory_evaluate", "team_evaluate"]}
          />
        </Section>
      )}
    </>
  );
}
