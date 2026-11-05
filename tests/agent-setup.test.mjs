import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAgent } from "../scripts/setup-agent.mjs";
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "wle-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const optional = async (p) => {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
test("configuration preview writes nothing and install preserves existing Codex and Qoder settings", async (t) => {
  const dir = await home(t);
  await mkdir(join(dir, ".codex"));
  await mkdir(join(dir, ".qoder"));
  const original =
    'model = "example-model"\n[mcp_servers.existing]\ncommand = "example"\n';
  await writeFile(join(dir, ".codex/config.toml"), original);
  await writeFile(
    join(dir, ".qoder/settings.json"),
    JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "other" } },
    }),
  );
  const preview = await configureAgent({ home: dir, client: "all" });
  assert.equal(preview.installed, false);
  assert.equal(
    await readFile(join(dir, ".codex/config.toml"), "utf8"),
    original,
  );
  assert.equal(
    await optional(join(dir, ".agents/skills/workloom-eval/SKILL.md")),
    null,
  );
  await configureAgent({ home: dir, client: "all", install: true });
  const codex = await readFile(join(dir, ".codex/config.toml"), "utf8");
  assert.ok(codex.startsWith(original));
  assert.match(codex, /\[mcp_servers.workloom_eval\]/);
  assert.match(codex, /agent-launcher.mjs/);
  const qoder = JSON.parse(
    await readFile(join(dir, ".qoder/settings.json"), "utf8"),
  );
  assert.equal(qoder.theme, "dark");
  assert.equal(qoder.mcpServers.other.command, "other");
  assert.ok(
    !(
      await readFile(join(dir, ".agents/skills/workloom-eval/SKILL.md"), "utf8")
    ).includes("/ABSOLUTE/PATH/TO/"),
  );
  await configureAgent({ home: dir, client: "all", install: true });
  assert.equal(await readFile(join(dir, ".codex/config.toml"), "utf8"), codex);
});
test("unsafe URLs, non-JSON Qoder config and unmanaged MCP names fail without overwriting", async (t) => {
  const dir = await home(t);
  for (const url of [
    "http://remote.example",
    "https://name:password@example.com",
    "https://example.com/?key=value",
  ])
    await assert.rejects(
      configureAgent({ home: dir, url }),
      (e) => e.code === "UNSAFE_URL",
    );
  await mkdir(join(dir, ".codex"));
  await writeFile(
    join(dir, ".codex/config.toml"),
    '[mcp_servers.workloom_eval]\ncommand="other"\n',
  );
  await assert.rejects(
    configureAgent({ home: dir, install: true }),
    (e) => e.code === "CONFIG_CONFLICT",
  );
  await mkdir(join(dir, ".qoder"));
  await writeFile(join(dir, ".qoder/settings.json"), "// special JSONC\n{}");
  await assert.rejects(
    configureAgent({ home: dir, client: "qoder", install: true }),
    (e) => e.code === "CONFIG_JSON_INVALID",
  );
  assert.equal(
    await readFile(join(dir, ".qoder/settings.json"), "utf8"),
    "// special JSONC\n{}",
  );
});

test("all valid TOML spellings and embedded markers remain unchanged on conflict", async (t) => {
  const dir = await home(t);
  await mkdir(join(dir, ".codex"));
  const samples = [
    "['mcp_servers'.workloom_eval]\ncommand='other'\n",
    '"mcp_servers" = {workloom_eval={command="other"}}\n',
    '[mcp_servers]\nworkloom_eval={command="other"}\n',
    'instructions = \"\"\"\n# BEGIN WORKLOOM EVAL MCP\noriginal instructions\n# END WORKLOOM EVAL MCP\n\"\"\"\n',
  ];
  for (const old of samples) {
    await writeFile(join(dir, ".codex/config.toml"), old);
    await assert.rejects(configureAgent({ home: dir, install: true }));
    assert.equal(await readFile(join(dir, ".codex/config.toml"), "utf8"), old);
  }
});
