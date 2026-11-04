import { useState } from "react";
import {
  CircleHelp,
  Download,
  Plus,
  RefreshCw,
  WandSparkles,
} from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Section,
  Tabs,
  Table,
} from "../components";
import { recordName } from "../view-utils";
import { post } from "../api";
import { JobList } from "./JobList";

export function Training({ ctx }) {
  const [tab, setTab] = useState("skills");
  const [versionError, setVersionError] = useState(null);
  const [creatingVersion, setCreatingVersion] = useState("");
  async function createCandidate(training) {
    setCreatingVersion(training.id);
    setVersionError(null);
    try {
      const result = await ctx.action("training-version-" + training.id, () =>
        post(
          "/api/training/" +
            encodeURIComponent(training.id) +
            "/create-version",
          {},
        ),
      );
      if (!result.versionId)
        throw new Error("服务未返回候选版本标识，请核对训练任务后再操作。");
      ctx.notify("已创建待评测员工版本；请完成岗位评测后再决定使用范围。");
      ctx.open("versions", result.versionId);
    } catch (failure) {
      setVersionError(failure);
    } finally {
      setCreatingVersion("");
    }
  }
  return (
    <>
      <Tabs
        tabs={[
          { id: "skills", label: "技能改进" },
          {
            id: "finetune",
            label: "模型微调",
            count: ctx.data.training.length,
          },
          { id: "data", label: "训练数据导出" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "skills" && (
        <Section
          title="从失败证据生成技能修复候选"
          sub="保留原技能和改动依据；脚本候选通过私有执行器验证。"
        >
          <div className="feature-intro">
            <WandSparkles size={37} />
            <h3>把失败变成具体的工作方法改进</h3>
            <p>
              选择失败评测和对应技能，生成新的声明式步骤或受限脚本候选。权限与验收规则不由优化器修改。
            </p>
            <Button
              primary
              disabled={
                !ctx.canEdit || !ctx.data.skills.length || !ctx.data.runs.length
              }
              onClick={() => ctx.jobForm("skill_repair")}
            >
              创建技能修复任务
            </Button>
          </div>
          <JobList ctx={ctx} types={["skill_repair"]} />
        </Section>
      )}
      {tab === "finetune" && (
        <>
          <div className="notice">
            <CircleHelp size={18} />
            <p>
              模型权重微调与提示词／技能迭代分别管理。只有供应商明确提供微调接口且已配置能力时才提交；不支持的配置会返回明确错误。
            </p>
          </div>
          <Section
            title="模型微调任务"
            action={
              <Button
                primary
                icon={Plus}
                disabled={!ctx.canEdit}
                onClick={() => ctx.jobForm("fine_tune")}
              >
                创建微调任务
              </Button>
            }
          >
            {versionError && <ErrorBox error={versionError} />}
            <Table
              rows={ctx.data.training}
              onRow={(t) => ctx.open("training", t.id)}
              columns={[
                { key: "name", label: "训练任务" },
                {
                  key: "employeeId",
                  label: "员工",
                  render: (t) =>
                    recordName("employees", t.employeeId, ctx.data),
                },
                { key: "externalJobId", label: "供应商任务" },
                { key: "resultModel", label: "产出模型" },
                {
                  key: "status",
                  label: "状态",
                  render: (t) => <Badge value={t.status} />,
                },
                {
                  key: "createVersion",
                  label: "",
                  render: (training) =>
                    training.status === "succeeded" ? (
                      <Button
                        primary
                        busy={creatingVersion === training.id}
                        disabled={
                          !ctx.canEdit ||
                          !training.resultModel ||
                          Boolean(creatingVersion)
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          createCandidate(training);
                        }}
                      >
                        创建待评测版本
                      </Button>
                    ) : null,
                },
                {
                  key: "poll",
                  label: "",
                  render: (t) => (
                    <Button
                      icon={RefreshCw}
                      disabled={!ctx.canEdit || !t.externalJobId}
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await ctx.runJob("poll_training", {
                            trainingId: t.id,
                          });
                        } catch (error) {
                          ctx.notify(error.message, "error");
                        }
                      }}
                    >
                      同步进度
                    </Button>
                  ),
                },
              ]}
            />
          </Section>
          <JobList ctx={ctx} types={["fine_tune", "poll_training"]} />
        </>
      )}
      {tab === "data" && (
        <Section
          title="导出有来源的训练数据"
          sub="按训练用途导出 JSONL；盲测集不用于训练。"
        >
          <Table
            rows={ctx.data.datasets.filter((d) => d.purpose === "train")}
            columns={[
              { key: "name", label: "训练集" },
              { key: "description", label: "范围" },
              {
                key: "count",
                label: "样本数",
                render: (d) =>
                  ctx.data.cases.filter((c) => c.datasetId === d.id).length,
              },
              {
                key: "export",
                label: "",
                render: (d) => (
                  <Button
                    icon={Download}
                    onClick={() =>
                      ctx.exportFile(
                        "/api/training/export/" + d.id,
                        d.name + ".jsonl",
                      )
                    }
                  >
                    导出 JSONL
                  </Button>
                ),
              },
            ]}
            empty={
              <Empty
                title="还没有训练用途的数据集"
                text="先在仿真与测试集中创建训练集，并维护经过核验的输入和预期。"
              />
            }
          />
        </Section>
      )}
    </>
  );
}
