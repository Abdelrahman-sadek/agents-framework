import type { Agent, AgentRunResult, AgentRuntime, RecoverOptions, ResumeOptions, RunOptions, StreamCallbacks } from "./agent.js";
import { passthroughContext, type ContextManager } from "./context.js";
import {
  AgentError,
  ApprovalExpiredError,
  CancellationError,
  ConfigurationError,
  FrameworkError,
  GuardrailError,
  VerificationError,
  LimitExceededError,
  LLMError,
  OutputValidationError,
  RunTimeoutError,
  ToolNotFoundError,
  ValidationError,
  type LimitType,
  type SerializedError,
} from "./errors.js";
import { createEventEmitter, type AgentEvent, type EventCorrelation, type EventEmitterHandle, type EventSink } from "./events.js";
import { applyGuardrails, type GuardrailStage } from "./guardrail.js";
import type { JsonSchema, Schema } from "./schema.js";
import { resolveLimits, validateLimits } from "./limits.js";
import {
  estimateCostUsd,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamEvent,
  type LLMToolCall,
  type LLMToolDefinition,
  type ModelCapabilities,
} from "./llm.js";
import { randomIds, systemClock, type Clock, type IdGenerator } from "./runtime-deps.js";
import { InMemoryRunStateStore, type RunStateStore } from "./state-store.js";
import type { AgentTool, ApprovalDecision, ApprovalRequest, ToolInvoker } from "./tool.js";
import {
  emptyUsage,
  type AgentState,
  type ExecutionStep,
  type PendingApproval,
  type RunLimits,
  type StepKind,
} from "./types.js";

export interface RuntimeOptions {
  /** LLM providers, resolved by `model.providerId`. */
  providers: readonly LLMProvider[];
  /** Required when any agent declares tools. Every tool call goes through it. */
  tools?: ToolInvoker;
  events?: EventSink | readonly EventSink[];
  /** Defaults to an in-memory store. Use a durable adapter in production. */
  stateStore?: RunStateStore;
  context?: ContextManager;
  /** Framework-level default limits (lowest precedence). */
  limits?: RunLimits;
  /** Backoff for retryable model errors. */
  retry?: { initialDelayMs?: number; maxDelayMs?: number };
  clock?: Clock;
  ids?: IdGenerator;
  /** Called when an event sink throws. Sinks never break a run. */
  onSinkError?: (error: unknown, event: AgentEvent) => void;
}

/** Create an explicit, non-global runtime. Invalid configuration fails fast. */
export function createRuntime(options: RuntimeOptions): AgentRuntime {
  if (options.providers.length === 0) {
    throw new ConfigurationError("createRuntime: at least one LLM provider is required");
  }
  const ids = new Set<string>();
  for (const provider of options.providers) {
    if (typeof provider.id !== "string" || provider.id === "") {
      throw new ConfigurationError("createRuntime: every provider needs a non-empty id");
    }
    if (ids.has(provider.id)) throw new ConfigurationError(`createRuntime: duplicate provider id '${provider.id}'`);
    ids.add(provider.id);
  }
  validateLimits(options.limits, "createRuntime");
  return new DefaultAgentRuntime(options);
}

interface Execution {
  agent: Agent<unknown>;
  state: AgentState;
  provider: LLMProvider;
  capabilities: ModelCapabilities;
  toolDefs: LLMToolDefinition[];
  toolsByName: Map<string, AgentTool>;
  emitter: EventEmitterHandle;
  outputJsonSchema: JsonSchema | undefined;
  callbacks: StreamCallbacks;
  signal: AbortSignal;
  dispose(): void;
}

class DefaultAgentRuntime implements AgentRuntime {
  private readonly store: RunStateStore;
  /** Runs this process is resuming; the fallback guard for stores without `claim()`. */
  private readonly resuming = new Set<string>();
  private readonly context: ContextManager;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly sinks: readonly EventSink[];
  private readonly providers: Map<string, LLMProvider>;

  constructor(private readonly options: RuntimeOptions) {
    this.store = options.stateStore ?? new InMemoryRunStateStore();
    this.context = options.context ?? passthroughContext;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
    const events = options.events;
    this.sinks = events === undefined ? [] : Array.isArray(events) ? [...(events as readonly EventSink[])] : [events as EventSink];
    this.providers = new Map(options.providers.map((p) => [p.id, p]));
  }

  getState(runId: string): Promise<AgentState | undefined> {
    return this.store.load(runId);
  }

  async run<TOutput>(agent: Agent<TOutput>, options: RunOptions): Promise<AgentRunResult<TOutput>> {
    const { provider, capabilities } = await this.prepare(agent);
    if (options.input === undefined) throw new ValidationError("run: input is required");
    validateLimits(options.limits, "run");
    const limits = resolveLimits(this.options.limits, agent.config.limits, options.limits);

    const runId = options.runId ?? this.ids.next("run");
    if (options.runId !== undefined && (await this.store.load(runId)) !== undefined) {
      throw new ValidationError(`run: run '${runId}' already exists`, { runId });
    }

    const now = this.nowISO();
    const state: AgentState = {
      runId,
      agentId: agent.id,
      ...(agent.version === undefined ? {} : { agentVersion: agent.version }),
      status: "RUNNING",
      input: options.input,
      ...(options.user === undefined ? {} : { user: options.user }),
      messages: [
        ...(agent.config.instructions === undefined ? [] : [{ role: "system" as const, content: agent.config.instructions }]),
        { role: "user", content: renderInput(options.input) },
      ],
      steps: [],
      usage: emptyUsage(),
      pendingApprovals: [],
      contextItems: [],
      corrections: { output: 0, reflection: 0 },
      limits,
      metadata: options.metadata ?? {},
      eventSequence: 0,
      createdAt: now,
      updatedAt: now,
    };

    const exec = this.createExecution(agent as Agent<unknown>, state, provider, capabilities, options.signal, options);
    exec.emitter.emit("AGENT_STARTED", {
      ...(agent.version === undefined ? {} : { agentVersion: agent.version }),
      ...(options.user === undefined ? {} : { userId: options.user.userId }),
      ...(options.user?.tenantId === undefined ? {} : { tenantId: options.user.tenantId }),
    });
    await this.drive(exec, async () => {
      await this.startRun(exec);
      await this.loop(exec);
    });
    return this.result<TOutput>(exec);
  }

  async resume<TOutput>(agent: Agent<TOutput>, options: ResumeOptions): Promise<AgentRunResult<TOutput>> {
    if (this.resuming.has(options.runId)) {
      throw new ValidationError(`resume: run '${options.runId}' is already being resumed`, { runId: options.runId });
    }
    this.resuming.add(options.runId);
    try {
      return await this.resumeClaimed(agent, options);
    } finally {
      this.resuming.delete(options.runId);
    }
  }

  private async resumeClaimed<TOutput>(agent: Agent<TOutput>, options: ResumeOptions): Promise<AgentRunResult<TOutput>> {
    const { provider, capabilities } = await this.prepare(agent);
    const state = await this.store.load(options.runId);
    if (state === undefined) throw new ValidationError(`resume: run '${options.runId}' not found`);
    if (state.agentId !== agent.id) {
      throw new ValidationError(`resume: run '${options.runId}' belongs to agent '${state.agentId}'`, { runId: state.runId });
    }
    if (state.status !== "WAITING_FOR_APPROVAL") {
      throw new ValidationError(`resume: run '${options.runId}' is ${state.status}, not WAITING_FOR_APPROVAL`, { runId: state.runId });
    }
    const decisions = new Map<string, ApprovalDecision>();
    const pendingIds = new Set(state.pendingApprovals.map((p) => p.approval.approvalId));
    for (const decision of options.approvals) {
      if (!pendingIds.has(decision.approvalId)) {
        throw new ValidationError(`resume: approval '${decision.approvalId}' is not pending for this run`, { runId: state.runId });
      }
      if (decision.decision === "escalated" && (decision.escalateTo === undefined || decision.escalateTo === "")) {
        throw new ValidationError(`resume: escalation of '${decision.approvalId}' needs escalateTo`, { runId: state.runId });
      }
      decisions.set(decision.approvalId, decision);
    }
    if (options.timeoutMs !== undefined) {
      validateLimits({ timeoutMs: options.timeoutMs }, "resume");
      state.limits = { ...state.limits, timeoutMs: options.timeoutMs };
    }

    // Compare-and-set so concurrent resumes (other processes included) cannot both run the approved tools.
    if (this.store.claim !== undefined && !(await this.store.claim(state.runId, "WAITING_FOR_APPROVAL", "RUNNING"))) {
      throw new ValidationError(`resume: run '${options.runId}' is already being resumed`, { runId: state.runId });
    }
    state.status = "RUNNING";
    const exec = this.createExecution(agent as Agent<unknown>, state, provider, capabilities, options.signal, options);
    exec.emitter.emit("AGENT_RESUMED", {
      decisions: [...decisions.values()].map((d) => ({ approvalId: d.approvalId, decision: d.decision })),
    });

    await this.drive(exec, async () => {
      const now = this.clock.now().getTime();
      const remaining: PendingApproval[] = [];
      const decided: [PendingApproval, ApprovalDecision][] = [];
      for (const pending of state.pendingApprovals) {
        const decision = decisions.get(pending.approval.approvalId);
        if (decision === undefined) remaining.push(pending);
        else decided.push([pending, decision]);
      }
      for (const [pending] of decided) {
        const expiresAt = pending.approval.expiresAt;
        if (expiresAt !== undefined && now > Date.parse(expiresAt)) {
          throw new ApprovalExpiredError(`Approval '${pending.approval.approvalId}' expired at ${expiresAt}`, {
            runId: state.runId,
            toolCallId: pending.toolCall.id,
          });
        }
      }
      state.pendingApprovals = remaining;
      for (const [pending, decision] of decided) {
        if (decision.decision === "escalated") {
          pending.approval.escalatedTo = [...(pending.approval.escalatedTo ?? []), decision.escalateTo ?? ""];
          state.pendingApprovals.push(pending);
          exec.emitter.emit(
            "TOOL_APPROVAL_ESCALATED",
            {
              toolCallId: pending.toolCall.id,
              toolName: pending.toolCall.name,
              approvalId: decision.approvalId,
              escalateTo: decision.escalateTo ?? "",
              ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
            },
            { stepId: pending.stepId, toolCallId: pending.toolCall.id },
          );
          continue;
        }
        const call =
          decision.decision === "modified"
            ? { ...pending.toolCall, arguments: JSON.stringify(decision.modifiedArguments ?? {}) }
            : pending.toolCall;
        await this.invokeTool(exec, call, pending.llmCallId, { request: pending.approval, decision, stepId: pending.stepId });
      }
      if (this.waitIfPending(exec)) return;
      await this.loop(exec);
    });
    return this.result<TOutput>(exec);
  }

  /**
   * Continue a run whose worker died (status still RUNNING in the store).
   * Tool calls requested by the last model turn that have no recorded result
   * are invoked again (tool idempotency keys protect side effects); then the
   * loop continues from the last checkpoint.
   */
  async recover<TOutput>(agent: Agent<TOutput>, options: RecoverOptions): Promise<AgentRunResult<TOutput>> {
    const { provider, capabilities } = await this.prepare(agent);
    const state = await this.store.load(options.runId);
    if (state === undefined) throw new ValidationError(`recover: run '${options.runId}' not found`);
    if (state.agentId !== agent.id) throw new ValidationError(`recover: run '${options.runId}' belongs to agent '${state.agentId}'`);
    if (state.status !== "RUNNING") throw new ValidationError(`recover: run '${options.runId}' is ${state.status}, not RUNNING`, { runId: state.runId });
    const exec = this.createExecution(agent as Agent<unknown>, state, provider, capabilities, options.signal);
    for (const step of state.steps) {
      if (step.status === "RUNNING") step.status = "FAILED";
    }
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
    const answered = new Set(state.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
    const waiting = new Set(state.pendingApprovals.map((p) => p.toolCall.id));
    const missing = lastAssistant?.role === "assistant" ? (lastAssistant.toolCalls ?? []).filter((c) => !answered.has(c.id) && !waiting.has(c.id)) : [];
    const llmCallId = [...state.steps].reverse().find((s) => s.kind === "llm_call")?.llmCallId ?? "recovered";
    exec.emitter.emit("AGENT_RECOVERED", { pendingToolCalls: missing.length });
    await this.drive(exec, async () => {
      await this.runToolCalls(exec, missing, llmCallId);
      if (this.waitIfPending(exec)) return;
      await this.loop(exec);
    });
    return this.result<TOutput>(exec);
  }

  // ---------------------------------------------------------------- setup

  private async prepare<TOutput>(agent: Agent<TOutput>): Promise<{
    provider: LLMProvider;
    capabilities: ModelCapabilities;
  }> {
    const { model, tools } = agent.config;
    const provider = this.providers.get(model.providerId);
    if (provider === undefined) {
      throw new ConfigurationError(`No LLM provider registered with id '${model.providerId}'`);
    }
    if ((tools?.length ?? 0) > 0 && this.options.tools === undefined) {
      throw new ConfigurationError(
        `Agent '${agent.config.name}' declares tools but the runtime has no tool invoker. Pass \`tools: new ToolRuntime()\` to createRuntime().`,
      );
    }
    const reported = await provider.capabilities(model.modelId);
    const capabilities: ModelCapabilities = { ...reported, ...model.capabilities, providerId: provider.id, modelId: model.modelId };
    if ((tools?.length ?? 0) > 0 && !capabilities.toolCalling) {
      throw new ConfigurationError(`Model '${provider.id}/${model.modelId}' does not support tool calling`);
    }
    return { provider, capabilities };
  }

  private createExecution(
    agent: Agent<unknown>,
    state: AgentState,
    provider: LLMProvider,
    capabilities: ModelCapabilities,
    external: AbortSignal | undefined,
    callbacks: StreamCallbacks = {},
  ): Execution {
    const controller = new AbortController();
    const onExternalAbort = (): void => {
      const reason: unknown = external?.reason;
      controller.abort(
        reason instanceof FrameworkError ? reason : new CancellationError("Run was cancelled by the caller", { runId: state.runId }),
      );
    };
    if (external !== undefined) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timeoutMs = state.limits.timeoutMs;
    const timer = setTimeout(() => controller.abort(new RunTimeoutError(timeoutMs, { runId: state.runId })), timeoutMs);
    const tools = agent.config.tools ?? [];
    return {
      agent,
      state,
      provider,
      capabilities,
      toolDefs: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      toolsByName: new Map(tools.map((t) => [t.name, t])),
      emitter: createEventEmitter({
        runId: state.runId,
        agentId: state.agentId,
        sinks: callbacks.onEvent === undefined ? this.sinks : [...this.sinks, { emit: callbacks.onEvent }],
        clock: this.clock,
        ids: this.ids,
        startSequence: state.eventSequence,
        onSequence: (n) => {
          state.eventSequence = n;
        },
        ...(this.options.onSinkError === undefined ? {} : { onSinkError: this.options.onSinkError }),
      }),
      outputJsonSchema: agent.config.outputJsonSchema ?? deriveJsonSchema(agent.config.output),
      callbacks,
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      },
    };
  }

  // ---------------------------------------------------------------- loop

  private async drive(exec: Execution, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      this.fail(exec, error);
    } finally {
      exec.dispose();
    }
    await this.checkpoint(exec);
  }

  private async loop(exec: Execution): Promise<void> {
    const { state } = exec;
    for (;;) {
      this.throwIfAborted(exec);
      if (state.usage.llmCalls >= state.limits.maxSteps) {
        throw this.limitExceeded(exec, "steps", state.limits.maxSteps, state.usage.llmCalls);
      }
      const { response, llmCallId } = await this.callModel(exec);
      if (response.toolCalls.length === 0) {
        if (await this.complete(exec, response.content)) return;
        continue;
      }
      // Checkpoint before side effects, so a crashed worker can recover exactly these tool calls.
      await this.checkpoint(exec);
      await this.runToolCalls(exec, response.toolCalls, llmCallId);
      if (this.waitIfPending(exec)) return;
      await this.checkpoint(exec);
    }
  }

  private async runToolCalls(exec: Execution, calls: readonly LLMToolCall[], llmCallId: string): Promise<void> {
    const { state } = exec;
    for (const call of calls) {
      this.throwIfAborted(exec);
      if (state.usage.toolCalls >= state.limits.maxToolCalls) {
        throw this.limitExceeded(exec, "toolCalls", state.limits.maxToolCalls, state.usage.toolCalls + 1);
      }
      state.usage.toolCalls += 1;
      await this.invokeTool(exec, call, llmCallId);
    }
  }

  private async callModel(exec: Execution): Promise<{ response: LLMResponse; llmCallId: string }> {
    const { state, provider, capabilities, emitter } = exec;
    const llmCallId = this.ids.next("llm");
    const step = this.startStep(exec, "llm_call", { llmCallId });
    const assembled = await this.context.assemble({
      runId: state.runId,
      agentId: state.agentId,
      messages: state.messages,
      items: state.contextItems,
      ...(capabilities.contextWindowTokens === undefined ? {} : { maxTokens: capabilities.contextWindowTokens }),
    });
    if ((assembled.omitted?.length ?? 0) > 0) {
      emitter.emit(
        "CONTEXT_ASSEMBLED",
        {
          messageCount: assembled.messages.length,
          ...(assembled.estimatedTokens === undefined ? {} : { estimatedTokens: assembled.estimatedTokens }),
          ...(assembled.omitted === undefined ? {} : { omitted: assembled.omitted }),
        },
        { stepId: step.stepId, llmCallId },
      );
    }
    const { settings, output } = exec.agent.config;
    const request: LLMRequest = {
      modelId: capabilities.modelId,
      messages: assembled.messages,
      ...(exec.toolDefs.length > 0 ? { tools: exec.toolDefs } : {}),
      ...(output !== undefined && capabilities.structuredOutput
        ? { responseFormat: { type: "json" as const, ...(exec.outputJsonSchema === undefined ? {} : { schema: exec.outputJsonSchema }) } }
        : {}),
      ...(settings === undefined ? {} : { settings }),
      signal: exec.signal,
      metadata: { runId: state.runId, agentId: state.agentId, llmCallId },
    };
    const base = { llmCallId, providerId: provider.id, modelId: capabilities.modelId };
    const correlation = { stepId: step.stepId, llmCallId };

    let response: LLMResponse | undefined;
    for (let attempt = 1; response === undefined; attempt++) {
      emitter.emit(
        "LLM_CALL_STARTED",
        { ...base, attempt, messageCount: request.messages.length, toolCount: exec.toolDefs.length },
        correlation,
      );
      const startedAt = Date.now();
      try {
        const onDelta = exec.callbacks.onTextDelta;
        const streamed = onDelta !== undefined && provider.stream !== undefined && capabilities.streaming;
        response = normalizeResponse(
          await raceAbort(
            streamed ? collectStream(provider.stream!(request), (delta) => onDelta(delta, { llmCallId })) : provider.generate(request),
            exec.signal,
          ),
        );
        step.attempts = attempt;
        const cost = estimateCostUsd(response.usage, capabilities.pricing);
        const usage = state.usage;
        usage.llmCalls += 1;
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.cachedInputTokens += response.usage.cachedInputTokens ?? 0;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
        usage.estimatedCostUsd += cost;
        emitter.emit(
          "LLM_CALL_COMPLETED",
          {
            ...base,
            finishReason: response.finishReason,
            usage: response.usage,
            estimatedCostUsd: cost,
            toolCallCount: response.toolCalls.length,
            durationMs: Date.now() - startedAt,
          },
          correlation,
        );
      } catch (error) {
        this.throwIfAborted(exec);
        const normalized = FrameworkError.from(error, (message, cause) => new LLMError(message, { cause }));
        const willRetry = normalized.retryable && attempt <= state.limits.maxLLMRetries;
        const serialized = { ...normalized.toJSON(), runId: state.runId, llmCallId };
        emitter.emit("LLM_CALL_FAILED", { ...base, attempt, willRetry, error: serialized }, correlation);
        if (!willRetry) {
          step.attempts = attempt;
          this.failStep(exec, step, serialized);
          throw normalized;
        }
        await sleep(this.backoff(attempt), exec.signal).catch(() => this.throwIfAborted(exec));
      }
    }

    state.messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });
    this.completeStep(exec, step);

    const { maxTokens, maxCost } = state.limits;
    if (maxTokens !== undefined && state.usage.totalTokens > maxTokens) {
      throw this.limitExceeded(exec, "tokens", maxTokens, state.usage.totalTokens);
    }
    if (maxCost !== undefined && state.usage.estimatedCostUsd > maxCost) {
      throw this.limitExceeded(exec, "cost", maxCost, state.usage.estimatedCostUsd);
    }
    return { response, llmCallId };
  }

  private async invokeTool(
    exec: Execution,
    call: LLMToolCall,
    llmCallId: string,
    resumed?: { request: ApprovalRequest; decision: ApprovalDecision; stepId: string },
  ): Promise<void> {
    const { state, emitter } = exec;
    const existing = resumed === undefined ? undefined : state.steps.find((s) => s.stepId === resumed.stepId);
    let step: ExecutionStep;
    if (existing === undefined) {
      step = this.startStep(exec, "tool_call", { llmCallId, toolCallId: call.id, toolName: call.name });
      emitter.emit("TOOL_REQUESTED", { toolCallId: call.id, toolName: call.name }, { stepId: step.stepId, llmCallId, toolCallId: call.id });
    } else {
      step = existing;
      step.status = "RUNNING";
    }

    const tool = exec.toolsByName.get(call.name);
    if (tool === undefined || this.options.tools === undefined) {
      const error = new ToolNotFoundError(`Tool '${call.name}' is not available to this agent`, {
        runId: state.runId,
        toolCallId: call.id,
      }).toJSON();
      this.pushToolMessage(exec, call, errorContent(error), true);
      this.failStep(exec, step, error);
      return;
    }

    const result = await raceAbort(
      this.options.tools.invoke({
        tool,
        toolCallId: call.id,
        rawArguments: call.arguments,
        runId: state.runId,
        stepId: step.stepId,
        llmCallId,
        identity: {
          agent: {
            agentId: exec.agent.id,
            name: exec.agent.name,
            ...(exec.agent.version === undefined ? {} : { version: exec.agent.version }),
            permissions: exec.agent.config.permissions ?? [],
          },
          ...(state.user === undefined ? {} : { user: state.user }),
        },
        signal: exec.signal,
        emit: emitter.emit,
        ...(resumed === undefined ? {} : { approval: { request: resumed.request, decision: resumed.decision } }),
      }),
      exec.signal,
    );
    step.attempts = result.attempts;

    switch (result.status) {
      case "success": {
        const raw = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
        let content: string;
        let isError = false;
        try {
          content = await this.guard(exec, "tool_result", raw, call.name);
        } catch (error) {
          if (!(error instanceof GuardrailError)) throw error;
          content = errorContent(error.toJSON());
          isError = true;
        }
        this.pushToolMessage(exec, call, content, isError);
        this.completeStep(exec, step);
        return;
      }
      case "approval_required": {
        if (result.approval === undefined) {
          throw new AgentError(`Tool invoker returned approval_required without an approval request`, { runId: state.runId });
        }
        step.status = "WAITING_FOR_APPROVAL";
        state.pendingApprovals.push({ approval: result.approval, toolCall: call, stepId: step.stepId, llmCallId });
        return;
      }
      case "rejected": {
        const error = result.error ?? { code: "APPROVAL_REJECTED", message: "Rejected by reviewer", category: "policy", retryable: false };
        this.pushToolMessage(exec, call, errorContent(error), true);
        step.status = "REJECTED";
        step.completedAt = this.nowISO();
        step.error = error;
        return;
      }
      case "error":
      case "denied": {
        const error = result.error ?? { code: "TOOL_ERROR", message: "Tool call failed", category: "tool", retryable: false };
        this.pushToolMessage(exec, call, errorContent(error), true);
        this.failStep(exec, step, error);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- transitions

  private waitIfPending(exec: Execution): boolean {
    const { state } = exec;
    if (state.pendingApprovals.length === 0) return false;
    state.status = "WAITING_FOR_APPROVAL";
    exec.emitter.emit("AGENT_WAITING_FOR_APPROVAL", { approvals: state.pendingApprovals.map((p) => p.approval) });
    return true;
  }

  /** Run input guardrails and context providers once, before the first model call. */
  private async startRun(exec: Execution): Promise<void> {
    const { state, emitter } = exec;
    const index = state.messages.findIndex((m) => m.role === "user");
    const message = state.messages[index];
    let query = message?.content ?? "";
    if (message !== undefined) {
      query = await this.guard(exec, "input", message.content);
      state.messages[index] = { role: "user", content: query };
    }
    for (const provider of exec.agent.config.context ?? []) {
      this.throwIfAborted(exec);
      const startedAt = Date.now();
      const items = await raceAbort(
        provider.provide({
          runId: state.runId,
          agentId: state.agentId,
          input: state.input,
          query,
          ...(state.user === undefined ? {} : { user: state.user }),
          metadata: state.metadata,
          signal: exec.signal,
          emit: emitter.emit,
        }),
        exec.signal,
      );
      state.contextItems.push(...items);
      emitter.emit("CONTEXT_RETRIEVED", { provider: provider.name, itemCount: items.length, durationMs: Date.now() - startedAt });
    }
  }

  /** Apply guardrails for a stage. Returns the (possibly redacted) content; throws GuardrailError when blocked. */
  private async guard(exec: Execution, stage: GuardrailStage, content: string, toolName?: string): Promise<string> {
    const guardrails = exec.agent.config.guardrails ?? [];
    if (guardrails.length === 0) return content;
    const { state, emitter } = exec;
    const outcome = await applyGuardrails(guardrails, content, {
      stage,
      runId: state.runId,
      agentId: state.agentId,
      ...(state.user === undefined ? {} : { user: state.user }),
      ...(toolName === undefined ? {} : { toolName }),
    });
    const tool = toolName === undefined ? {} : { toolName };
    for (const r of outcome.redactions) {
      emitter.emit("GUARDRAIL_TRIGGERED", { guardrail: r.guardrail, stage, action: "redact", reason: r.reason, ...tool });
    }
    if (outcome.blocked !== undefined) {
      emitter.emit("GUARDRAIL_TRIGGERED", { guardrail: outcome.blocked.guardrail, stage, action: "block", reason: outcome.blocked.reason, ...tool });
      throw new GuardrailError(`Content blocked by guardrail '${outcome.blocked.guardrail}' at ${stage}`, {
        runId: state.runId,
        metadata: { guardrail: outcome.blocked.guardrail, stage },
      });
    }
    return outcome.content;
  }

  /**
   * Accept a final answer: output guardrails → schema validation (with
   * correction) → verification (with revision). Returns false when the model
   * was asked to try again.
   */
  private async complete(exec: Execution, content: string): Promise<boolean> {
    const { state, emitter } = exec;
    const text = await this.guard(exec, "output", content);
    let output: unknown = text;

    const schema = exec.agent.config.output;
    if (schema !== undefined) {
      const parsed = parseOutput(schema, text, state.runId);
      if (!parsed.ok) {
        const willRetry = state.corrections.output < state.limits.maxOutputCorrections;
        emitter.emit("OUTPUT_VALIDATION_FAILED", { attempt: state.corrections.output + 1, willRetry, error: parsed.error.toJSON() });
        if (!willRetry) throw parsed.error;
        state.corrections.output += 1;
        state.messages.push({
          role: "user",
          content: `Your previous answer was rejected: ${parsed.error.message}. Reply again with only a JSON value that matches the required schema.`,
        });
        return false;
      }
      output = parsed.value;
    }

    const verifiers = exec.agent.config.reflection?.verifiers ?? [];
    if (verifiers.length > 0) {
      const attempt = state.corrections.reflection + 1;
      const failures: { verifier: string; feedback: string }[] = [];
      for (const verifier of verifiers) {
        this.throwIfAborted(exec);
        let result;
        try {
          result = await verifier.verify({
            runId: state.runId,
            agentId: state.agentId,
            input: state.input,
            text,
            output,
            contextItems: state.contextItems,
            messages: state.messages,
            signal: exec.signal,
          });
        } catch (error) {
          this.throwIfAborted(exec);
          result = { passed: false, feedback: `Verifier error: ${error instanceof Error ? error.message : String(error)}` };
        }
        emitter.emit("VERIFICATION_COMPLETED", {
          verifier: verifier.name,
          passed: result.passed,
          attempt,
          ...(result.score === undefined ? {} : { score: result.score }),
        });
        if (!result.passed) failures.push({ verifier: verifier.name, feedback: result.feedback ?? "Failed verification" });
      }
      if (failures.length > 0) {
        const willRetry = state.corrections.reflection < state.limits.maxReflectionAttempts;
        emitter.emit("VERIFICATION_FAILED", { attempt, willRetry, failures });
        if (!willRetry) {
          throw new VerificationError(`Answer failed verification: ${failures.map((f) => f.verifier).join(", ")}`, {
            runId: state.runId,
            metadata: { failures },
          });
        }
        state.corrections.reflection += 1;
        state.messages.push({
          role: "user",
          content: `Your previous answer did not pass review:\n${failures.map((f) => `- ${f.verifier}: ${f.feedback}`).join("\n")}\nRevise your answer to address every point.`,
        });
        return false;
      }
    }

    state.output = output;
    state.status = "COMPLETED";
    emitter.emit("AGENT_COMPLETED", { usage: { ...state.usage } });
    return true;
  }

  private fail(exec: Execution, error: unknown): void {
    const { state, emitter } = exec;
    const normalized = FrameworkError.from(error, (message, cause) => new AgentError(message, { cause }));
    const serialized: SerializedError = { ...normalized.toJSON(), runId: state.runId };
    state.error = serialized;
    for (const step of state.steps) {
      if (step.status === "RUNNING") this.failStep(exec, step, serialized);
    }
    if (normalized instanceof CancellationError) {
      state.status = "CANCELLED";
      emitter.emit("AGENT_CANCELLED", { reason: normalized.message });
    } else if (normalized instanceof RunTimeoutError) {
      state.status = "TIMED_OUT";
      emitter.emit("AGENT_TIMED_OUT", { timeoutMs: state.limits.timeoutMs });
    } else {
      state.status = normalized instanceof ApprovalExpiredError ? "APPROVAL_EXPIRED" : "FAILED";
      emitter.emit("AGENT_FAILED", { error: serialized, usage: { ...state.usage } });
    }
  }

  private limitExceeded(exec: Execution, limitType: LimitType, limit: number, current: number): LimitExceededError {
    exec.emitter.emit("LIMIT_EXCEEDED", { limitType, limit, current });
    return new LimitExceededError(limitType, limit, current, { runId: exec.state.runId });
  }

  private startStep(exec: Execution, kind: StepKind, extra: Partial<ExecutionStep>): ExecutionStep {
    const step: ExecutionStep = {
      stepId: this.ids.next("step"),
      index: exec.state.steps.length,
      kind,
      status: "RUNNING",
      startedAt: this.nowISO(),
      ...extra,
    };
    exec.state.steps.push(step);
    exec.emitter.emit("STEP_STARTED", { stepId: step.stepId, kind, index: step.index }, correlationOf(step));
    return step;
  }

  private completeStep(exec: Execution, step: ExecutionStep): void {
    step.status = "COMPLETED";
    step.completedAt = this.nowISO();
    exec.emitter.emit("STEP_COMPLETED", { stepId: step.stepId, kind: step.kind }, correlationOf(step));
  }

  private failStep(exec: Execution, step: ExecutionStep, error: SerializedError): void {
    step.status = "FAILED";
    step.completedAt = this.nowISO();
    step.error = error;
    exec.emitter.emit("STEP_FAILED", { stepId: step.stepId, kind: step.kind, error }, correlationOf(step));
  }

  private pushToolMessage(exec: Execution, call: LLMToolCall, content: string, isError: boolean): void {
    exec.state.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content, ...(isError ? { isError } : {}) });
  }

  private async checkpoint(exec: Execution): Promise<void> {
    exec.state.updatedAt = this.nowISO();
    await this.store.save(exec.state);
  }

  private throwIfAborted(exec: Execution): void {
    if (exec.signal.aborted) throw abortReason(exec.signal);
  }

  private backoff(attempt: number): number {
    const initial = this.options.retry?.initialDelayMs ?? 250;
    const max = this.options.retry?.maxDelayMs ?? 4_000;
    return Math.min(max, initial * 2 ** (attempt - 1));
  }

  private nowISO(): string {
    return this.clock.now().toISOString();
  }

  private result<TOutput>(exec: Execution): AgentRunResult<TOutput> {
    const { state } = exec;
    return {
      runId: state.runId,
      agentId: state.agentId,
      status: state.status,
      ...(state.status === "COMPLETED" ? { output: state.output as TOutput } : {}),
      ...(state.error === undefined ? {} : { error: state.error }),
      steps: state.steps.map((s) => ({ ...s })),
      usage: { ...state.usage },
      pendingApprovals: state.pendingApprovals.map((p) => p.approval),
      events: exec.emitter.events,
    };
  }
}

// ---------------------------------------------------------------- helpers

/** Consume a provider stream, forwarding text deltas, and return the final response. */
async function collectStream(stream: AsyncIterable<LLMStreamEvent>, onDelta: (delta: string) => void): Promise<LLMResponse> {
  for await (const event of stream) {
    if (event.type === "content_delta") onDelta(event.delta);
    else if (event.type === "done") return event.response;
    else if (event.type === "error") throw new LLMError(event.error.message, { retryable: event.error.retryable, metadata: { code: event.error.code } });
  }
  throw new LLMError("Stream ended without a final response", { retryable: true });
}

function correlationOf(step: ExecutionStep): EventCorrelation {
  return {
    stepId: step.stepId,
    ...(step.llmCallId === undefined ? {} : { llmCallId: step.llmCallId }),
    ...(step.toolCallId === undefined ? {} : { toolCallId: step.toolCallId }),
  };
}

function renderInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function errorContent(error: SerializedError): string {
  return JSON.stringify({ error: { code: error.code, message: error.message } });
}

function parseOutput<T>(
  schema: Schema<T>,
  text: string,
  runId: string,
): { ok: true; value: T } | { ok: false; error: OutputValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (cause) {
    return { ok: false, error: new OutputValidationError("Model output is not valid JSON", { cause, runId }) };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: new OutputValidationError(`Model output failed schema validation: ${result.error.message}`, { runId }) };
  }
  return { ok: true, value: result.data };
}

function deriveJsonSchema(schema: unknown): JsonSchema | undefined {
  const candidate = schema as { toJSONSchema?: unknown } | undefined;
  if (candidate === undefined || typeof candidate.toJSONSchema !== "function") return undefined;
  try {
    const { $schema: _ignored, ...json } = (candidate.toJSONSchema as () => Record<string, unknown>).call(schema);
    return json;
  } catch {
    return undefined;
  }
}

function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return match?.[1] ?? text;
}

function normalizeResponse(response: LLMResponse): LLMResponse {
  if (typeof response !== "object" || response === null || typeof response.content !== "string") {
    throw new LLMError("Provider returned a malformed response", { retryable: false });
  }
  return { ...response, toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls : [] };
}

function abortReason(signal: AbortSignal): FrameworkError {
  const reason: unknown = signal.reason;
  return reason instanceof FrameworkError ? reason : new CancellationError();
}

/** Resolve with `promise`, or reject as soon as `signal` aborts — even if the callee ignores the signal. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Abortable delay. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
