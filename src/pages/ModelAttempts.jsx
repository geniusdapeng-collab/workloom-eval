import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { request, post, num, date } from "../api";
import { Badge, Button, Empty, ErrorBox, Section, Table } from "../components";

export function ModelAttempts({ ctx }) {
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isAdmin = ctx.session?.role === "admin";
  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await request("/api/model-attempts");
      if (!Array.isArray(result) && !Array.isArray(result.attempts))
        throw new Error("未决请求接口返回了无法识别的数据，请刷新后重试。");
      setAttempts(Array.isArray(result) ? result : result.attempts);
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);
  useEffect(() => {
    load();
  }, [load]);
  function reconcile(attempt) {
    const id = attempt.attemptId || attempt.id;
    ctx.setForm({
      title: "核对供应商请求终态",
      subtitle:
        "此处记录管理员向供应商核实的证据，不会重新发送模型请求。未核对前，相同请求不会重发。",
      wide: true,
      fields: [
        {
          key: "outcome",
          label: "供应商确认的结果",
          type: "select",
          required: true,
          options: [
            { value: "not_executed", label: "供应商确认未执行" },
            { value: "completed", label: "供应商确认已执行完成" },
          ],
        },
        {
          key: "source",
          label: "供应商核对依据",
          type: "textarea",
          required: true,
          help: "填写供应商控制台记录、工单或回执依据。不要粘贴密钥、原始提示词或客户资料。",
        },
        {
          key: "responseId",
          label: "供应商响应／回执 ID",
          help: "结果为“已执行完成”时必填。",
        },
        {
          key: "promptTokens",
          label: "实际输入 Token",
          type: "number",
          min: 0,
          step: 1,
          help: "填写供应商实际用量；未执行时留空。",
        },
        {
          key: "completionTokens",
          label: "实际输出 Token",
          type: "number",
          min: 0,
          step: 1,
          help: "已执行完成时必填，包含供应商计费的输出。",
        },
        {
          key: "totalTokens",
          label: "实际总 Token",
          type: "number",
          min: 0,
          step: 1,
          help: "应等于输入与输出之和；不能填估算值。",
        },
      ],
      submitLabel: "保存核对证据",
      submit: async (body) => {
        const evidence = {
          outcome: body.outcome,
          source: body.source.trim(),
        };
        if (body.outcome === "completed") {
          if (!body.responseId?.trim())
            throw new Error("已完成的供应商请求必须填写实际响应或回执 ID。");
          const values = [
            body.promptTokens,
            body.completionTokens,
            body.totalTokens,
          ];
          if (
            values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
            body.totalTokens !== body.promptTokens + body.completionTokens
          )
            throw new Error(
              "请填写供应商实际的输入、输出和总 Token；总量必须等于输入与输出之和。",
            );
          evidence.responseId = body.responseId.trim();
          evidence.usage = {
            prompt_tokens: body.promptTokens,
            completion_tokens: body.completionTokens,
            total_tokens: body.totalTokens,
          };
        }
        await ctx.action(
          "attempt-" + id,
          () =>
            post(
              "/api/model-attempts/" + encodeURIComponent(id) + "/reconcile",
              evidence,
            ),
          "已记录供应商核对证据并结算预留；该操作没有重发模型请求。",
        );
        await load();
      },
    });
  }
  return (
    <Section
      title="未决供应商请求"
      sub="保留发送结果或用量尚不明确的请求，核对前不重复发送。"
      action={
        <Button
          icon={RefreshCw}
          busy={loading}
          disabled={!isAdmin}
          onClick={load}
        >
          刷新未决记录
        </Button>
      }
    >
      {!isAdmin ? (
        <Empty
          icon={ShieldCheck}
          title="仅管理员可核对供应商请求"
          text="请由工作区管理员根据供应商回执核对，不以猜测释放请求预留。"
        />
      ) : (
        <>
          {error && <ErrorBox error={error} retry={load} />}
          {loading && !attempts.length ? (
            <div className="loading-line">正在读取未决请求…</div>
          ) : (
            <Table
              rows={attempts}
              rowKey="attemptId"
              columns={[
                {
                  key: "attemptId",
                  label: "请求",
                  render: (attempt) => (
                    <div>
                      <strong>{attempt.scene || "模型调用"}</strong>
                      <small className="table-secondary">
                        {attempt.attemptId || attempt.id}
                      </small>
                    </div>
                  ),
                },
                {
                  key: "requestedModel",
                  label: "模型",
                  render: (attempt) =>
                    attempt.requestedModel || attempt.model || "—",
                },
                {
                  key: "reservationTokens",
                  label: "保留 Token",
                  render: (attempt) => num(attempt.reservationTokens),
                },
                {
                  key: "status",
                  label: "状态",
                  render: () => <Badge value="uncertain">待供应商核对</Badge>,
                },
                {
                  key: "recordedAt",
                  label: "记录时间",
                  render: (attempt) =>
                    date(attempt.recordedAt || attempt.createdAt),
                },
                {
                  key: "action",
                  label: "",
                  render: (attempt) => (
                    <Button
                      disabled={!isAdmin}
                      onClick={() => reconcile(attempt)}
                    >
                      提供核对证据
                    </Button>
                  ),
                },
              ]}
              empty={
                <Empty
                  icon={ShieldCheck}
                  title="当前没有未决供应商请求"
                  text="真实调用出现终态或用量不明时，请求将保留在这里等待核实。"
                />
              }
            />
          )}
        </>
      )}
    </Section>
  );
}
