import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createModel, MODEL_REGISTRY } from "../server/model.mjs";
const response = (overrides = {}) => ({
  data: {
    id: "test-response",
    model: "deepseek-flash",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: '{"ok":true}' },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    ...overrides,
  },
});
function setup(transport) {
  const store = createStore();
  store.create("models", {
    id: "m",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    secretRef: "env:DEEPSEEK_API_KEY",
    contextTokens: 1048576,
    maxOutputTokens: 393216,
  });
  return {
    store,
    model: createModel({
      store,
      envSecrets: { "env:DEEPSEEK_API_KEY": "test-only-not-real-key" },
      transport,
    }),
  };
}
const input = {
  modelId: "m",
  messages: [{ role: "user", content: "Return JSON" }],
  scene: "schema.test",
};
test("dispatcher uses verified canonical ID, explicit thinking and legal output ceiling", async () => {
  let body;
  const { store, model } = setup(async (r) => {
    body = r.body;
    return response();
  });
  const result = await model.complete(input);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.max_tokens, 393216);
  assert.equal(result.value.ok, true);
  assert.equal(result.receipt.sentOutputCeiling, 393216);
  assert.equal(
    JSON.stringify(store.list("receipts")).includes("test-only-not-real-key"),
    false,
  );
  store.close();
});
test("tool messages retain thinking context transiently and permit valid tool-call responses", async () => {
  let body;
  const raw = {
    role: "assistant",
    content: null,
    reasoning_content: "transient-private-thinking",
    tool_calls: [
      {
        id: "call",
        type: "function",
        function: { name: "query", arguments: "{}" },
      },
    ],
  };
  const { store, model } = setup(async (r) => {
    body = r.body;
    return response({
      choices: [{ finish_reason: "tool_calls", message: raw }],
    });
  });
  const result = await model.complete({
    ...input,
    scene: "employee.execute",
    json: false,
    messages: [
      { role: "user", content: "test" },
      raw,
      { role: "tool", tool_call_id: "call", content: "{}" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "query", parameters: { type: "object" } },
      },
    ],
  });
  assert.equal(
    body.messages[1].reasoning_content,
    "transient-private-thinking",
  );
  assert.equal(result.message.reasoning_content, "transient-private-thinking");
  assert.equal(
    JSON.stringify(store.list("receipts")).includes(
      "transient-private-thinking",
    ),
    false,
  );
  store.close();
});
for (const [name, overrides, code] of [
  ["wrong model", { model: "different" }, "MODEL_IDENTITY_MISMATCH"],
  [
    "truncated",
    { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    "MODEL_TRUNCATED",
  ],
  [
    "empty",
    {
      choices: [
        {
          finish_reason: "stop",
          message: { content: "  ", reasoning_content: "thinking" },
        },
      ],
    },
    "EMPTY_MODEL_RESULT",
  ],
  [
    "invalid JSON",
    { choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] },
    "INVALID_MODEL_JSON",
  ],
  ["missing usage", { usage: undefined }, "MISSING_USAGE"],
  [
    "wrong thinking",
    {
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
    "THINKING_POLICY_MISMATCH",
  ],
])
  test(`dispatcher fails closed on ${name}`, async () => {
    const { store, model } = setup(async () => response(overrides));
    await assert.rejects(model.complete(input), { code });
    assert.equal(
      store
        .list("receipts")
        .some((r) => ["failed", "unresolved"].includes(r.status)),
      true,
    );
    store.close();
  });
test("missing workspace key cannot borrow a different workspace environment secret", async () => {
  let calls = 0;
  const { store, model } = setup(async () => {
    calls++;
    return response();
  });
  store.create(
    "models",
    {
      id: "m2",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      secretRef: "env:DEEPSEEK_API_KEY",
    },
    "other",
  );
  await assert.rejects(
    model.complete({ ...input, workspace: "other", modelId: "m2" }),
    { code: "SECRET_NOT_CONFIGURED" },
  );
  assert.equal(calls, 0);
  store.close();
});
test("budget denials emit receipts but zero outbound calls", async () => {
  let calls = 0;
  const { store, model } = setup(async () => {
    calls++;
    return response();
  });
  await assert.rejects(model.complete({ ...input, budgetTokens: 1 }), {
    code: "BUDGET_EXCEEDED",
  });
  assert.equal(calls, 0);
  assert.equal(store.list("receipts")[0].status, "denied");
  store.close();
});
test("actual usage is settled once and unresolved calls retain their accounting reservation", async () => {
  const { store, model } = setup(async () => response());
  const j = store.create("jobs", {
    type: "test",
    status: "running",
    budgetTokens: 500000,
    usedTokens: 0,
  });
  await model.withBudget(j, () => model.complete(input));
  assert.equal(store.get("jobs", j.id).usedTokens, 30);
  store.close();
});
test("search executes official endpoint and preserves real result receipts", async () => {
  let sent;
  const { store, model } = setup(async (r) => {
    sent = r;
    return {
      data: {
        results: [
          {
            title: "source",
            url: "https://example.com",
            content: "source body",
          },
        ],
      },
    };
  });
  const out = await model.search({ modelId: "m", query: "公开事实", count: 3 });
  assert.equal(sent.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(sent.body.need_content, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.receipt.toolMode, "real");
  await assert.rejects(model.search({ modelId: "m", query: "x".repeat(129) }), {
    code: "INVALID_SEARCH_QUERY",
  });
  store.close();
});
test("estimated monetary cost uses explicit frozen rates and cache usage without claiming bill settlement", async () => {
  const { store, model } = setup(async () =>
    response({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        prompt_cache_hit_tokens: 800,
      },
    }),
  );
  const out = await model.complete(input);
  assert.equal(out.usage.costBasis, "official-peak-bound-estimate");
  assert.ok(
    Math.abs(
      out.usage.costUSD - (200 * 0.3 + 800 * 0.006 + 200 * 1.2) / 1000000,
    ) < 1e-12,
  );
  assert.equal(out.receipt.pricingSnapshot.source, MODEL_REGISTRY.source);
  store.close();
});
