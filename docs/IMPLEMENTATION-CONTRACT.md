# WorkLoom Eval implementation contract

Task T-2026-1104-0001. P0-P2 implementation scope; actual evidence levels and external environment limits are recorded in [FEATURE-MATRIX.md](FEATURE-MATRIX.md) and [ACCEPTANCE.md](ACCEPTANCE.md). Node >=24 ESM .mjs; React/Vite .jsx. SQLite node:sqlite. API and built UI share the origin at 127.0.0.1:4317 by default; this does not establish a public production deployment. Root owns package.json, server/store.mjs, model.mjs, index.mjs, seed.mjs, integration tests. UI owns src/**, index.html,vite.config.mjs. Engine owns server/engine.mjs + tests/engine.test.mjs. Advanced owns server/tools.mjs, advanced.mjs,scripts/runner.mjs and tests.

## Store

Sync methods: store.list(kind,workspace='default'); get(kind,id,workspace) returns object or throws404; create(kind,data,workspace); put(kind,obj,workspace,{expectedRevision}={}); remove(kind,id,workspace); transaction(fn); event(workspace,kind,subjectId,data); events(workspace,subjectId?). Every object has id,workspace,revision,createdAt,updatedAt. Frozen versions and historical runs immutable. Always scope referenced resources to workspace. Root API hides holdout case inputs and answers from bootstrap.

Kinds (representative business fields; dedicated workflows add frozen manifests, checkpoints, receipts and provenance):
employees {name,role,description,status,currentVersionId,requirements,accessMode:'managed'|'http',endpoint}
versions {employeeId,parentId,label,prompt,knowledgeIds,toolIds,skillIds,modelId,policy:{maxSteps,allowWrites,allowSearch,approvalLimit},retrieval:{topK,chunkSize,overlap,minScore},changeSummary,manifestHash,status}
knowledge {name,content,source,tags,status,published,version,allowedModelEgress}
tools {name,description,adapter:'simulation'|'http'|'mcp'|'browser'|'script',operation,inputSchema,outputSchema,mode:'simulated'|'test'|'readonly'|'production',config,secretRef,permissions}
skills {name,description,steps:[],content,version,toolIds}
models {name,provider,baseUrl,model,contextTokens,maxOutputTokens,thinking,search,secretRef,status,pricing?,training?}; no secrets in resources
datasets {name,purpose:'train'|'dev'|'validation'|'holdout',description,caseIds,judgeModelId?}
cases {datasetId,name,input,expected,category,initialState,assertions:[{type:'state'|'contains'|'not_contains'|'tool_called'|'no_violation'|'artifact',path,operator,value}],fault,hidden}
jobs {type,payload,status:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted',progress,result,error,budgetTokens,usedTokens,cancelRequested}
runs {versionId,datasetId,jobId,status,caseResults,metrics,manifest,evidenceLevel,modelMode,toolMode}
optimizations {employeeId,baselineVersionId,jobId,candidates,bestVersionId,rounds,stopReason}
reports {versionId,runId,title,summary,recommendation,limitations,metrics,comparison}
teams {name,description,members:[{employeeId,versionId,task}],memoryPolicy}
memories {employeeId,scope,content,source,expiresAt,approved}
deployments {employeeId,versionId,previousVersionId,target,mode,status,receipt,policy}
training {name,employeeId,baselineVersionId,datasetId,providerModelId,providerSnapshot,status,externalJobId,resultModel,metrics,providerReceipt,adoptedModelId?,candidateVersionId?}
nodes {name,endpoint,capabilities,lastSeen,status,tokenHash}
experiences {name,summary,sourceRunId,tags,approved,visibility}
reviews {runId,caseId,decision,reason}

## Model

model.complete({workspace,modelId,modelConfig?,scene,messages,json=true,tools=[],signal,budgetTokens,search=false}) returns {content,value,toolCalls,message,usage:{inputTokens,outputTokens,totalTokens,costUSD?,costBasis?},receipt}. Only dispatcher calls inference providers; controlled external HTTP adapters use model.request. message contains transient reasoning_content to preserve thinking tool history; never persist raw reasoning. Default DeepSeek canonical deepseek-flash (verified mapping is recorded in the model registry), POST https://api.deepseek.com/chat/completions. Separate search_web/fetch_web_page functions use the official search/fetch APIs; implemented adapters do not by themselves prove real execution. No silent fallback/mock. model.available(workspace), model.test(modelId,workspace), model.status(). Keys env or process memory only.

Employee generation chooses payload.modelId, then settings.defaultModelId, then the authorized built-in model-deepseek, then the sole authorized model if only one exists. Ambiguous multiple-model selection fails. A newly registered training result does not silently become the workspace default.

## Tools

createToolService({store,model}) returns {execute,probe}. execute({workspace,toolId,args,state,mode='simulated',signal}) returns {result,state,receipt,violation?}; isolated mutable state per case. simulation actions query/read/update/refund/publish/list/calculate. Validate schemas/permissions. state.__fault injection. HTTP/MCP require explicit allowlist; deny private egress unless configured. browser/script jobs execute registered authenticated runner, never arbitrary host code.

## Engine

createEngine({store,model,tools}) returns {executeJob,createVersion,buildReport}. createVersion(employeeId,config,workspace); buildReport(run,workspace). executeJob(job,ctx), ctx={workspace,signal,onProgress(percent,message),jobId}.
Job create_employee payload {requirements,name?,modelId?,knowledgeIds?,toolIds?,skillIds?,autoEvaluate?}: real model structured generation, reuse only authorized asset IDs, gaps explicit. Create employee+frozen V0.1+dev dataset. Result {employeeId,versionId,datasetId,gaps}.
Job evaluate {versionId,datasetId,repeats?,mode?,budgetTokens?,judgeModelId?}: frozen assets+tool loop+rules+semantic judge. Result {runId,reportId,checkpointIds,metrics}. caseResults [{caseId,name,status,input,output,steps,assertions,score,passed,error,latencyMs,usage,finalState,violations}]. metrics {score,passRate,passed,total,valid,failed,incomplete,violations,latencyMs,tokens,costUSD?}.
Job optimize {versionId,datasetId,validationDatasetId?,maxRounds?,candidatesPerRound?,budgetTokens?,judgeModelId?}: only train/dev optimization; no holdout exposure; material prompt/declared skill/retrieval patches; immutable candidate versions; compare under same conditions, retain worse candidates, stop budget/cancel/plateau. Result {optimizationId,bestVersionId,baselineRunId}.
Judge precedence for standalone evaluation/optimization is payload.judgeModelId, dataset.judgeModelId, settings.defaultJudgeModelId, then the frozen worker as a compatibility default. Optimization freezes one judge configuration across baseline, candidates and stage validation. Manifest separates workerModelConfigHash from judgeModelConfigHash; comparisonHash fixes dataset, evaluator, repeats and mode while allowing different worker weights. Current authorization and knowledge egress rules apply to both roles.
Job team_evaluate {teamId,input,datasetId?}: versioned members, explicit handoff, isolated/shared memory policy, member contributions.
Job memory_evaluate {employeeId,versionId,inputs:[],scope?}: temporal scope/expiry/no-leak tests.
Persist progress/evidence/errors, never claim promotion from generated dev cases alone. All model calls through model.complete, all tools through tools.execute.

## Advanced

createAdvanced({store,model,tools,engine}) returns {executeJob,exportTraining,recommendPortfolio,importExperience,shadow,deploy,rollback}. exportTraining(datasetId,workspace); recommendPortfolio(employeeId,workspace); importExperience(id,targetWorkspace,approval); deploy(payload,workspace); rollback(id,workspace).
Job fine_tune: capability-gated async provider HTTP adapter; unsupported provider must explicitly fail, never fake completion. poll_training actively verifies provider status. createTrainedVersion(trainingId,workspace) converts a matching succeeded receipt into a frozen candidate based on the submission-time baseline, without promotion or default-model changes; no actual external weight training is claimed without provider evidence. shadow_evaluate replays recorded input with simulated business tools. skill_repair creates restricted declarative skill candidates and evaluates them, never arbitrary host execution. browser_evaluate runs private registered tasks and returns actual node evidence; employee capability evaluation uses a bound browser tool through evaluate. benchmark_portfolio computes quality/cost/latency Pareto. long_horizon performs up to 100 scoped temporal memory steps with the same authorized frozen job context for worker and judge; candidate memories do not update approved production memory.
Job knowledge_regression refreshes only one published knowledge asset in affected bound versions, preserving other parent snapshots, and evaluates parent/candidate pairs; missing test data is an explicit gap. settings.autoKnowledgeRegression=false by default; enabling it queues a scoped job on knowledge publication/content update, not an unlimited schedule or automatic deployment.
Real deployments use POST plus independent GET readback, a durable per-employee lock and uncertain state after an ambiguous result. reconcile only reads status and never replays POST.

## API

GET /api/session -> {user,workspace,role,localMode}. POST /api/auth/login {email,password}; POST /api/auth/logout.
GET /api/bootstrap -> allowed public resource arrays + settings + overview. Hidden inputs/answers filtered; private execution, approval, receipt and checkpoint lists use controlled access.
GET/POST /api/resources/:kind; GET/PUT/DELETE /api/resources/:kind/:id. PUT body {expectedRevision,...object}. Frozen kinds denied updates/deletes.
POST /api/jobs {type,payload,budgetTokens?} ->202 job. GET /api/jobs/:id; POST /api/jobs/:id/cancel. GET /api/jobs/:id/checkpoints and POST /api/jobs/:id/resume preserve immutable case evidence; resume is limited to interrupted/failed/cancelled standalone simulated evaluations with matching conditions, remaining budget and no unresolved provider attempt.
POST /api/models/:id/test. POST /api/secrets {ref,value} process-memory only; GET /api/status.
POST /api/tools/:id/test. POST /api/import/knowledge multipart or JSON {name,content,source}. POST /api/datasets/import {name,purpose,cases}. POST /api/versions {employeeId,...config}.
GET /api/reports/:id/export?format=markdown|json|html. GET /api/versions/:id/export. GET /api/training/export/:datasetId JSONL. GET /api/portfolio/:employeeId.
POST /api/training/:id/create-version ->201 candidate/model references, promoted:false.
POST /api/deployments {employeeId,versionId,target,mode,policy}; POST /api/deployments/:id/rollback; POST /api/deployments/:id/reconcile.
GET /api/model-attempts; POST /api/model-attempts/:id/reconcile records administrator-supplied provider evidence, not automatic billing lookup.
POST /api/reviews {runId,caseId,decision,reason}. GET /api/events?subjectId.
POST /api/nodes/register {name,capabilities} ->once-only token; POST /api/nodes/:id/revoke and /rotate invalidate old credentials. POST /api/runner/claim,/heartbeat,/result use Bearer node auth and current fenced leases. Browser viewport and allowed steps come from the administrator registry, not task input. Root owns queue leases.
Error {error:{code,message,details?}}. 403permission409revision422invalid429budget503provider. Viewer cannot mutate. Workspace from session not request body.

## UI

Premium dark navy inspired by video; indigo primary/cyan activity; readable Chinese. Left nav+workspace+real-mode. Functional API pages: overview; natural-language create employee wizard; employees detail/assets/versions/export; assets CRUD/upload; model masked key config/test; datasets/scenario editor; three-column run evidence; iteration wizard/candidates; reports; teams; memories; shadow/deployments; fine-tuning; private nodes; experiences; Pareto portfolio; settings. 1440/1280/390 responsive. Every action wired, full loading/empty/error/disabled/cancel states. Seeds clearly reference scenarios, no fake scores. No coming-soon buttons.
