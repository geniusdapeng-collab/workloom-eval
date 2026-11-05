import { randomBytes } from "node:crypto";
import { HttpError, hash, id } from "./store.mjs";

const roles = ["viewer", "editor", "admin"];
export function createAgentAccess({ store, localMode }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_tokens(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,
    workspace TEXT NOT NULL,role TEXT NOT NULL,owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS agent_tokens_workspace ON agent_tokens(workspace,created_at);`);
  const publicRow = (r) => ({
    id: r.id,
    name: r.name,
    workspace: r.workspace,
    role: r.role,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  });
  return {
    list(workspace) {
      return store.db
        .prepare(
          "SELECT * FROM agent_tokens WHERE workspace=? ORDER BY created_at DESC",
        )
        .all(workspace)
        .map(publicRow);
    },
    issue(user, input) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new HttpError(
          422,
          "INVALID_AGENT_TOKEN",
          "凭据配置必须为JSON对象",
        );
      const role = input.role === undefined ? "editor" : input.role,
        ttl =
          input.expiresInSeconds === undefined
            ? 604800
            : input.expiresInSeconds;
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 120 ||
        !roles.includes(role) ||
        !Number.isSafeInteger(ttl) ||
        ttl < 3600 ||
        ttl > 7776000
      )
        throw new HttpError(
          422,
          "INVALID_AGENT_TOKEN",
          "需要名称、有效角色及3600至7776000秒有效期",
        );
      const token = "wle_" + randomBytes(32).toString("base64url"),
        created = Date.now();
      const row = {
        id: id("agt"),
        name: input.name.trim(),
        workspace: user.workspace,
        role,
        owner_id: user.id,
        created_at: created,
        expires_at: created + ttl * 1000,
      };
      store.transaction(() => {
        store.db
          .prepare("INSERT INTO agent_tokens VALUES(?,?,?,?,?,?,?,?,NULL)")
          .run(
            row.id,
            row.name,
            hash(token),
            row.workspace,
            role,
            user.id,
            created,
            row.expires_at,
          );
        store.event(user.workspace, "agent.token_issued", row.id, {
          name: row.name,
          role,
          ownerId: user.id,
          expiresAt: row.expires_at,
        });
      });
      return { credential: publicRow(row), token, oneTime: true };
    },
    revoke(workspace, tokenId) {
      const row = store.db
        .prepare("SELECT * FROM agent_tokens WHERE workspace=? AND id=?")
        .get(workspace, tokenId);
      if (!row) throw new HttpError(404, "NOT_FOUND", "凭据不存在或无权访问");
      store.transaction(() => {
        store.db
          .prepare(
            "UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE workspace=? AND id=?",
          )
          .run(Date.now(), workspace, tokenId);
        store.event(workspace, "agent.token_revoked", tokenId, {
          role: row.role,
        });
      });
      return { id: tokenId, revoked: true };
    },
    authenticate(header) {
      if (!/^Bearer \S+$/i.test(header || ""))
        throw new HttpError(401, "AGENT_AUTH_INVALID", "Agent认证格式无效");
      const raw = header.slice(7),
        row = store.db
          .prepare(
            "SELECT * FROM agent_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
          )
          .get(hash(raw), Date.now());
      if (!row)
        throw new HttpError(
          401,
          "AGENT_AUTH_INVALID",
          "Agent凭据无效、过期或已撤销",
        );
      let owner;
      if (row.owner_id === "local-owner" && localMode)
        owner = {
          id: row.owner_id,
          email: "local@workloom",
          workspace: "default",
          role: "admin",
        };
      else
        owner = store.db
          .prepare("SELECT id,email,workspace,role FROM users WHERE id=?")
          .get(row.owner_id);
      if (
        !owner ||
        owner.workspace !== row.workspace ||
        !roles.includes(owner.role) ||
        !roles.includes(row.role)
      )
        throw new HttpError(
          401,
          "AGENT_OWNER_INVALID",
          "凭据所属账户已失效或工作区已变化",
        );
      return {
        user: {
          ...owner,
          role: roles[
            Math.min(roles.indexOf(owner.role), roles.indexOf(row.role))
          ],
        },
        credentialId: row.id,
      };
    },
  };
}
