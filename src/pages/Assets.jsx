import { useState } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  ChevronRight,
  Code2,
  Plus,
  Wrench,
} from "lucide-react";
import { post, date, titles } from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Section,
  Tabs,
  Table,
} from "../components";
import { matches } from "../view-utils";

const helpTexts = {
  knowledge: "发布新修订后，已有员工版本仍绑定旧快照。",
  tools: "为每个工具明确接入方式、环境和权限。",
  skills: "将工作方法写成可执行步骤与异常路径。",
};

export function Assets({ ctx, fileRef }) {
  const [tab, setTab] = useState("knowledge");
  const [importError, setImportError] = useState(null);
  const { data, query } = ctx;
  function regressKnowledge(knowledge) {
    ctx.setForm({
      title: "受影响员工回归",
      subtitle:
        "对引用该知识的员工生成新知识快照候选并回归；历史版本保留原快照，结果不直接覆盖生产版本。",
      fields: [
        {
          key: "datasetId",
          label: "回归测试集（可选）",
          type: "select",
          options: data.datasets
            .filter((dataset) =>
              ["dev", "validation"].includes(dataset.purpose),
            )
            .map((dataset) => ({ value: dataset.id, label: dataset.name })),
          help: "留空时由后台选择适用回归集；无法找到用例时返回明确缺口。",
        },
      ],
      submitLabel: "启动受影响员工回归",
      submit: async (body) => {
        const job = await ctx.runJob("knowledge_regression", {
          knowledgeId: knowledge.id,
          ...(body.datasetId ? { datasetId: body.datasetId } : {}),
        });
        ctx.open("jobs", job.id || job.job?.id);
      },
    });
  }
  return (
    <>
      <Tabs
        tabs={[
          { id: "knowledge", label: "知识库", count: data.knowledge.length },
          { id: "tools", label: "工具 Tool", count: data.tools.length },
          { id: "skills", label: "技能 Skill", count: data.skills.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="section-toolbar">
        <span className="muted">{helpTexts[tab]}</span>
        <div>
          {tab === "knowledge" && (
            <>
              <input
                type="file"
                hidden
                ref={fileRef}
                accept=".md,.txt,.pdf,.csv,.json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setImportError(null);
                  const body = new FormData();
                  body.append("file", file);
                  try {
                    await ctx.action(
                      "upload",
                      () => post("/api/import/knowledge", body),
                      "资料已导入",
                    );
                  } catch (failure) {
                    setImportError(failure);
                  } finally {
                    e.target.value = "";
                  }
                }}
              />
              <Button
                icon={ArrowDownToLine}
                busy={ctx.actionBusy === "upload"}
                disabled={!ctx.canEdit}
                onClick={() => fileRef.current?.click()}
              >
                导入文档
              </Button>
            </>
          )}
          <Button
            primary
            icon={Plus}
            disabled={!ctx.canEdit}
            onClick={() => ctx.editResource(tab)}
          >
            新建{titles[tab]}
          </Button>
        </div>
      </div>
      {importError && <ErrorBox error={importError} />}
      <Section
        title={titles[tab]}
        sub={"共 " + data[tab].length + " 项 · 修订与员工引用可追溯"}
      >
        <Table
          rows={data[tab].filter((r) => matches(r, query))}
          onRow={(r) => ctx.open(tab, r.id)}
          columns={[
            {
              key: "name",
              label: "名称",
              render: (r) => (
                <div className="name-cell">
                  <span className="table-icon">
                    {tab === "knowledge" ? (
                      <BookOpen size={17} />
                    ) : tab === "tools" ? (
                      <Wrench size={17} />
                    ) : (
                      <Code2 size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{r.name}</strong>
                    <small>{r.description || r.source || r.id}</small>
                  </div>
                </div>
              ),
            },
            {
              key: "type",
              label: tab === "tools" ? "接入方式" : "修订",
              render: (r) => r.adapter || r.version || "r" + r.revision,
            },
            {
              key: "status",
              label: "状态",
              render: (r) => (
                <Badge
                  value={
                    r.mode || r.status || (r.published ? "active" : "draft")
                  }
                />
              ),
            },
            {
              key: "updatedAt",
              label: "更新时间",
              render: (r) => date(r.updatedAt),
            },
            {
              key: "action",
              label: "",
              render: (r) => (
                <div className="inline-actions">
                  {tab === "knowledge" && (
                    <Button
                      disabled={!ctx.canEdit || !r.published}
                      onClick={(event) => {
                        event.stopPropagation();
                        regressKnowledge(r);
                      }}
                    >
                      受影响员工回归
                    </Button>
                  )}
                  <button
                    className="text-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      ctx.editResource(tab, r);
                    }}
                    disabled={!ctx.canEdit}
                  >
                    编辑
                    <ChevronRight size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          empty={
            <Empty
              title={"还没有" + titles[tab]}
              text="创建后可以在员工版本中绑定使用。"
              action={
                <Button
                  icon={Plus}
                  disabled={!ctx.canEdit}
                  onClick={() => ctx.editResource(tab)}
                >
                  创建{titles[tab]}
                </Button>
              }
            />
          }
        />
      </Section>
    </>
  );
}
