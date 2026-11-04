import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  createHash,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const id = (prefix) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
export const immutableKinds = new Set([
  "versions",
  "runs",
  "reports",
  "receipts",
  "checkpoints",
]);
export const resourceKinds = [
  "employees",
  "versions",
  "knowledge",
  "tools",
  "skills",
  "models",
  "datasets",
  "cases",
  "jobs",
  "runs",
  "optimizations",
  "reports",
  "teams",
  "memories",
  "deployments",
  "training",
  "nodes",
  "experiences",
  "reviews",
  "approvals",
  "executions",
  "settings",
  "receipts",
  "checkpoints",
];
const blockedKeys = new Set(["__proto__", "prototype", "constructor"]);
export function validateData(value, depth = 0) {
  if (
    typeof value === "string" &&
    (/gh[pousr]_[A-Za-z0-9]{24,}/.test(value) ||
      /sk-[A-Za-z0-9]{24,}/.test(value))
  )
    throw new HttpError(
      422,
      "SECRET_IN_CONTENT",
      "检测到凭据内容，请使用专用密钥接口；不会持久化该内容",
    );
  if (depth > 40) throw new HttpError(422, "NESTING_LIMIT", "数据嵌套超过限制");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new HttpError(422, "INVALID_NUMBER", "数值必须有限");
  if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (blockedKeys.has(k))
        throw new HttpError(422, "UNSAFE_KEY", "数据包含不安全字段");
      if (
        /^(apiKey|password|authorization|accessToken|refreshToken|privateKey)$/i.test(
          k,
        ) &&
        v
      )
        throw new HttpError(
          422,
          "SECRET_IN_RESOURCE",
          "凭据请通过密钥接口配置",
        );
      validateData(v, depth + 1);
    }
  return value;
}
export function createStore(path = ":memory:") {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS resources(workspace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace,kind,id));
    CREATE INDEX IF NOT EXISTS resources_kind ON resources(workspace,kind,updated_at);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,kind TEXT NOT NULL,subject_id TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_subject ON events(workspace,subject_id,seq);
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only');END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only');END;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,workspace TEXT NOT NULL,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(workspace TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(workspace,key));`);
  let nesting = 0;
  function check(kind) {
    if (!resourceKinds.includes(kind))
      throw new HttpError(404, "UNKNOWN_RESOURCE", "资源类型不存在");
  }
  function event(workspace, kind, subjectId, data) {
    validateData(data);
    const previous =
      db
        .prepare(
          "SELECT hash FROM events WHERE workspace=? ORDER BY seq DESC LIMIT 1",
        )
        .get(workspace)?.hash || "genesis";
    const createdAt = new Date().toISOString(),
      digest = hash({ workspace, kind, subjectId, data, previous, createdAt });
    const r = db
      .prepare(
        "INSERT INTO events(workspace,kind,subject_id,data,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        workspace,
        kind,
        subjectId,
        JSON.stringify(data),
        previous,
        digest,
        createdAt,
      );
    return {
      seq: Number(r.lastInsertRowid),
      workspace,
      kind,
      subjectId,
      data,
      previousHash: previous,
      hash: digest,
      createdAt,
    };
  }
  const store = {
    db,
    transaction(fn) {
      if (nesting) return fn();
      db.exec("BEGIN IMMEDIATE");
      nesting++;
      try {
        const r = fn();
        if (r?.then)
          throw new Error("Database transaction must be synchronous");
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        nesting--;
      }
    },
    list(kind, workspace = "default") {
      check(kind);
      return db
        .prepare(
          "SELECT data FROM resources WHERE workspace=? AND kind=? ORDER BY created_at DESC,id",
        )
        .all(workspace, kind)
        .map((r) => JSON.parse(r.data));
    },
    get(kind, resourceId, workspace = "default") {
      check(kind);
      const r = db
        .prepare(
          "SELECT data FROM resources WHERE workspace=? AND kind=? AND id=?",
        )
        .get(workspace, kind, resourceId);
      if (!r) throw new HttpError(404, "NOT_FOUND", "资源不存在或无权访问");
      return JSON.parse(r.data);
    },
    create(kind, data, workspace = "default") {
      check(kind);
      validateData(data);
      if (Buffer.byteLength(JSON.stringify(data)) > 12 * 1024 * 1024)
        throw new HttpError(413, "RESOURCE_TOO_LARGE", "资源过大");
      const now = new Date().toISOString(),
        obj = {
          ...structuredClone(data),
          id: data.id || id(kind.slice(0, 4)),
          workspace,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      return store.transaction(() => {
        try {
          db.prepare("INSERT INTO resources VALUES(?,?,?,?,?,?,?)").run(
            workspace,
            kind,
            obj.id,
            1,
            JSON.stringify(obj),
            now,
            now,
          );
        } catch (e) {
          if (String(e).includes("UNIQUE"))
            throw new HttpError(409, "ALREADY_EXISTS", "资源标识重复");
          throw e;
        }
        event(workspace, "resource.created", obj.id, {
          resourceKind: kind,
          revision: 1,
          digest: hash(obj),
        });
        return obj;
      });
    },
    put(kind, obj, workspace = "default", { expectedRevision } = {}) {
      check(kind);
      validateData(obj);
      if (immutableKinds.has(kind))
        throw new HttpError(
          409,
          "IMMUTABLE_VERSION",
          "历史版本和证据不可修改，请创建新修订",
        );
      return store.transaction(() => {
        const old = store.get(kind, obj.id, workspace);
        if (
          expectedRevision !== undefined &&
          Number(expectedRevision) !== old.revision
        )
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "资源已更新，请刷新后重试",
          );
        const next = {
          ...old,
          ...structuredClone(obj),
          id: old.id,
          workspace,
          revision: old.revision + 1,
          createdAt: old.createdAt,
          updatedAt: new Date().toISOString(),
        };
        db.prepare(
          "UPDATE resources SET revision=?,data=?,updated_at=? WHERE workspace=? AND kind=? AND id=? AND revision=?",
        ).run(
          next.revision,
          JSON.stringify(next),
          next.updatedAt,
          workspace,
          kind,
          old.id,
          old.revision,
        );
        event(workspace, "resource.updated", old.id, {
          resourceKind: kind,
          revision: next.revision,
          digest: hash(next),
        });
        return next;
      });
    },
    remove(kind, resourceId, workspace = "default") {
      check(kind);
      if (immutableKinds.has(kind))
        throw new HttpError(
          409,
          "IMMUTABLE_VERSION",
          "冻结版本和历史证据不可删除",
        );
      return store.transaction(() => {
        store.get(kind, resourceId, workspace);
        const active = store
          .list("jobs", workspace)
          .some(
            (j) =>
              ["queued", "running"].includes(j.status) &&
              JSON.stringify(j.payload).includes(resourceId),
          );
        if (active)
          throw new HttpError(409, "RESOURCE_BUSY", "资源被运行任务引用");
        if (
          kind === "datasets" &&
          (store
            .list("cases", workspace)
            .some((c) => c.datasetId === resourceId) ||
            store
              .list("runs", workspace)
              .some((r) => r.datasetId === resourceId))
        )
          throw new HttpError(
            409,
            "DATASET_REFERENCED",
            "测试集被场景或历史评测引用，不能删除",
          );
        const versions = store
          .list("versions", workspace)
          .filter((v) =>
            JSON.stringify([
              v.knowledgeIds,
              v.toolIds,
              v.skillIds,
              v.modelId,
              v.employeeId,
            ]).includes(resourceId),
          );
        if (versions.length)
          throw new HttpError(
            409,
            "RESOURCE_REFERENCED",
            "资源被冻结版本引用，可创建新修订或归档",
          );
        db.prepare(
          "DELETE FROM resources WHERE workspace=? AND kind=? AND id=?",
        ).run(workspace, kind, resourceId);
        event(workspace, "resource.deleted", resourceId, {
          resourceKind: kind,
        });
        return { deleted: true };
      });
    },
    event,
    events(workspace = "default", subjectId) {
      const rows = subjectId
        ? db
            .prepare(
              "SELECT * FROM events WHERE workspace=? AND subject_id=? ORDER BY seq",
            )
            .all(workspace, subjectId)
        : db
            .prepare("SELECT * FROM events WHERE workspace=? ORDER BY seq")
            .all(workspace);
      return rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        subjectId: r.subject_id,
        data: JSON.parse(r.data),
        previousHash: r.previous_hash,
        hash: r.hash,
        createdAt: r.created_at,
      }));
    },
    verifyEvents(workspace = "default") {
      let previous = "genesis";
      for (const e of store.events(workspace)) {
        if (
          e.previousHash !== previous ||
          e.hash !==
            hash({
              workspace,
              kind: e.kind,
              subjectId: e.subjectId,
              data: e.data,
              previous,
              createdAt: e.createdAt,
            })
        )
          return false;
        previous = e.hash;
      }
      return true;
    },
    createUser({ email, password, workspace = "default", role = "viewer" }) {
      if (!["admin", "editor", "viewer"].includes(role) || password.length < 12)
        throw new HttpError(422, "INVALID_USER", "密码至少12位，角色必须有效");
      const salt = randomUUID(),
        user = { id: id("usr"), email: email.toLowerCase(), workspace, role };
      try {
        db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?)").run(
          user.id,
          user.email,
          scryptSync(password, salt, 64).toString("hex"),
          salt,
          workspace,
          role,
        );
      } catch (e) {
        if (String(e).includes("UNIQUE"))
          throw new HttpError(409, "USER_EXISTS", "用户已存在");
        throw e;
      }
      return user;
    },
    login(email, password) {
      const u = db
        .prepare("SELECT * FROM users WHERE email=?")
        .get(String(email).toLowerCase());
      const candidate = scryptSync(
        String(password),
        u?.salt || "invalid-salt",
        64,
      );
      if (
        !u ||
        !timingSafeEqual(candidate, Buffer.from(u.password_hash, "hex"))
      )
        throw new HttpError(401, "INVALID_CREDENTIALS", "邮箱或密码错误");
      const token = randomUUID() + randomUUID();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        hash(token),
        u.id,
        Date.now() + 12 * 3600000,
      );
      return {
        token,
        user: {
          id: u.id,
          email: u.email,
          workspace: u.workspace,
          role: u.role,
        },
      };
    },
    session(token) {
      if (!token) return null;
      const r = db
        .prepare(
          "SELECT users.id,email,workspace,role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?",
        )
        .get(hash(token), Date.now());
      return r || null;
    },
    logout(token) {
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
        hash(token || ""),
      );
    },
    userCount() {
      return db.prepare("SELECT count(*) AS n FROM users").get().n;
    },
    idempotent(workspace, key, request, fn) {
      if (!key) return fn();
      if (key.length > 160)
        throw new HttpError(422, "INVALID_KEY", "幂等键过长");
      return store.transaction(() => {
        const r = db
            .prepare("SELECT * FROM idempotency WHERE workspace=? AND key=?")
            .get(workspace, key),
          digest = hash(request);
        if (r) {
          if (r.request_hash !== digest)
            throw new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "幂等键已用于其他请求",
            );
          return JSON.parse(r.result);
        }
        const result = fn();
        db.prepare("INSERT INTO idempotency VALUES(?,?,?,?)").run(
          workspace,
          key,
          digest,
          JSON.stringify(result),
        );
        return result;
      });
    },
    close() {
      db.close();
    },
  };
  return store;
}
