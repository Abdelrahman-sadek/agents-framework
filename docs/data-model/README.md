# Data model

> **Implemented so far:** `AgentState`, `ExecutionStep`, `UsageTotals`, `PendingApproval` (`packages/core/src/types.ts`), `ApprovalRequest` / `ApprovalDecision` (`packages/core/src/tool.ts`), event envelopes (`events.ts`) and `ToolAuditRecord` (`packages/tools/src/stores.ts`). The entities below describe the full target model; durable tables are created by `migrate()` in `@agent-framework/production`: `agent_runs` (run state as JSONB, indexed by status and tenant), `agent_jobs` (queue with leases), `tool_audit` (append-only) and `tool_idempotency`.

The framework needs a persistent, reconstructable execution model. The data model is designed to answer:

- what happened?
- when?
- why?
- which agent?
- which user?
- which tools?
- which model?
- which data?
- which permissions?
- which failures?
- which retries?

## Core entities

### Run

Top-level unit of work.

Fields:

- `runId`
- `agentId`
- `userId`
- `tenantId`
- `organizationId`
- `status`
- `input`
- `output`
- `contextState`
- `plan`
- `steps`
- `metadata`
- `startTimestamp`
- `endTimestamp`
- `error`
- `budgetUsed`
- `traceContext`

### Execution

A durable execution unit. One run may map to one or more executions depending on orchestration and durable execution strategy.

Fields:

- `executionId`
- `runId`
- `status`
- `currentStep`
- `checkpoint`
- `parentExecutionId`
- `startedAt`
- `lastUpdatedAt`
- `error`

### Step

A step in a plan or orchestrated execution.

Fields:

- `stepId`
- `executionId`
- `planId`
- `description`
- `status`
- `workerId`
- `agentId`
- `inputs`
- `outputs`
- `dependencies`
- `timeout`
- `retryPolicy`
- `startedAt`
- `completedAt`
- `error`

### ToolCall

Tool execution record.

Fields:

- `toolCallId`
- `runId`
- `executionId`
- `stepId`
- `toolName`
- `toolVersion`
- `input`
- `output`
- `status`
- `authorizedBy`
- `permissionScope`
- `startedAt`
- `completedAt`
- `error`
- `retryCount`
- `auditable`

### Approval

Human approval record.

Fields:

- `approvalId`
- `runId`
- `executionId`
- `stepId`
- `toolCallId`
- `actionDescription`
- `requestedBy`
- `status`
- `requestedAt`
- `respondedAt`
- `respondedBy`
- `decision`
- `expiresAt`
- `escalationPath`

### LLMCall

LLM request/response record.

Fields:

- `llmCallId`
- `runId`
- `executionId`
- `stepId`
- `provider`
- `model`
- `requestSignature`
- `responseMetadata`
- `tokenUsage`
- `estimatedCost`
- `status`
- `startedAt`
- `completedAt`
- `error`

### Retrieval

Knowledge retrieval record.

Fields:

- `retrievalId`
- `runId`
- `executionId`
- `stepId`
- `query`
- `filters`
- `results`
- `reranked`
- `citations`
- `startedAt`
- `completedAt`

### MemoryOperation

Memory read/write/search record.

Fields:

- `memoryOperationId`
- `runId`
- `executionId`
- `operationType`
- `scope`
- `owner`
- `query`
- `resultSummary`
- `status`
- `startedAt`
- `completedAt`

### Event

Generic framework event for tracing lifecycle and audit.

Fields:

- `eventId`
- `runId`
- `executionId`
- `type`
- `occurredAt`
- `actor`
- `payload`
- `correlationId`
- `metadata`

### AgentDefinition

Metadata about the agent, its tools, knowledge, memory, planning, reflection, and security configuration.

Fields:

- `agentId`
- `name`
- `version`
- `configuration`
- `toolIds`
- `knowledgeBaseIds`
- `memoryScope`
- `planningConfig`
- `reflectionConfig`
- `securityConfig`
- `createdAt`
- `updatedAt`

### Tenant/Identity context

Tenant, organization, and user context associated with execution.

Fields:

- `tenantId`
- `organizationId`
- `userId`
- `agentId`
- `runId`
- `scopes`
- `permissionSet`
- `dataAccessContext`

## Relationships

- A `Run` has many `Execution`s when durable/orchestrated execution is used.
- An `Execution` has many `Step`s.
- A `Step` may have many `ToolCall`s.
- A `ToolCall` may be linked to an `Approval`.
- A `Run` has many `LLMCall`s.
- A `Run` has many `Retrieval`s.
- A `Run` has many `MemoryOperation`s.
- A `Run` has many `Event`s.
- `AgentDefinition` describes the static configuration for an `agentId`.
- `Tenant/Identity context` links execution to tenancy and authorization.

## Execution state model

Agent execution state must be explicit and reconstructable.

Example runtime state shape:

```typescript
interface AgentState {
  runId: string;
  agentId: string;
  status: AgentStatus;
  input: unknown;
  context: ContextState;
  plan?: Plan;
  steps: ExecutionStep[];
  memory?: MemoryState;
  metadata: Record<string, unknown>;
}
```

Status values include the lifecycle states described in the architecture docs, including approval and failure states.

## Determinism rule

LLMs may influence what the framework does, but they do not own runtime truth.

Runtime truth is held in:

- state
- permissions
- execution
- retries
- persistence
- audit
- budgets
- lifecycle

This is why the data model is event-rich and step-aware: it must be possible to reconstruct execution without re-prompting the LLM.
