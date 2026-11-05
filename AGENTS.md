# WorkLoom Eval development

This repository is the independent digital employee evaluation product authorized in T-2026-1104-0001. GitHub default branch is the source of truth. Do not modify or synchronize other WorkLoom products or isolated copies through this project.

Read README.md, product.manifest.json, docs/IMPLEMENTATION-CONTRACT.md and docs/FEATURE-MATRIX.md before changes. Preserve credentials in process environment or session memory only. Never persist current-task credentials in files, logs, Git configuration, remotes, issues or CI. All generation/review/optimization uses server/model.mjs; the default canonical model is deepseek-flash with official mapping recorded in its registry. No implicit fallback or fabricated model results.

Keep immutable employee versions, runs, reports, checkpoints and model receipts. Scope every resource and external request to the authenticated workspace. Apply current permissions as well as frozen permissions. Sealed datasets must not become optimizer input through edits, exports, reports or orphaned references. Shared knowledge/tool changes do not alter frozen versions.

External tools use the administrator network allowlist. Production writes require exact, unexpired, one-use approval. Evaluations reject production write mode. Private browser/script work requires registered node tasks and fenced leases. Do not execute arbitrary generated host code.

Use an isolated task branch and PR. Include the task ID in commits. Run pnpm check, pnpm test and pnpm build; perform real provider business-entry checks for model changes, and desktop/mobile visual QA for UI changes. Node test stubs prove contracts only, never claim actual provider execution. Source must pass secret scanning before push. Do not use platform AI review services. Integrate ordinary reviewed changes through PR and read back the main SHA. Record limitations precisely; missing provider capabilities must fail explicitly.

For product operation from Codex/Qoder, use docs/AGENT-INTEGRATION.md and integrations/agent-guide/AGENTS.md. The runtime Skill lives at integrations/skills/workloom-eval/SKILL.md. These consumer instructions do not replace repository development rules. CLI and MCP share client/operations.mjs and client/client.mjs; preserve their schemas, no automatic write retries, CAS, bounded waits, and truthful terminal state. Keep stdio MCP stdout protocol-only. Use the parser-validated setup installer; do not replace other host MCP/provider configuration or persist credentials in host config.
