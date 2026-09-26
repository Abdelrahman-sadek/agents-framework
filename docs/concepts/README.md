# Concepts

## Agent

An agent is a configured runtime participant with an identity, instructions, model access, tools, optional knowledge and memory, optional planning and reflection, and a security posture.

An agent does not mean “one LLM call.” It means “one controlled execution context.”

## Run

A run is one execution of an agent against a request. It is the primary unit of observability, persistence, and audit.

## Tool

A tool is a validated, authorized, bounded, and auditable action the agent can request. The framework mediates tool execution. The LLM does not execute tools directly.

## Context

Context is the information assembled for a model call. The context engine selects and budgets context from many sources rather than dumping everything into the prompt.

## Memory

Memory is information retained across time. It is separate from knowledge and is governed by policy.

## Knowledge

Knowledge is retrievable information, often from documents. It supports RAG with citations and source identity.

## Plan

A plan is a structured set of steps with dependencies, status, worker assignment, inputs, outputs, timeout, and retry policy. Plans are executed by the runtime.

## Worker

A worker is an isolated execution participant with limited permissions and tools. Workers are used in orchestrated and multi-agent execution.

## Reflection

Reflection is verification or critique of generated output. It is configurable and bounded.

## Orchestrator

The orchestrator coordinates tasks, plans, workers, dependencies, parallelism, failure handling, and aggregation.

## Guardrail

A guardrail is a control applied to input or output. Guardrails may include validation, content checks, policy checks, and restrictions.

## Policy engine

The policy engine makes authorization and policy decisions using identity, permissions, and tenant context.

## Approval

Approval is a first-class execution state for actions that require human or process consent.

## Durable execution

Durable execution is the ability to continue, pause, wait, retry, and recover across failures and restarts. The framework abstracts this behind a runner interface.

## Observability

Observability is the tracing, metrics, logs, and cost tracking that make execution inspectable. The framework uses OpenTelemetry.

## Evaluation

Evaluation is the practice of testing agent behavior against datasets and evaluators. It can include deterministic checks, LLM-based judges, and regression testing.

## Provider independence

Provider independence means core components should not depend on a single vendor. LSTM, embeddings, vector stores, storage, execution backends, observability, authentication, and memory stores should all be pluggable.

## Runtime vs. intelligence

Runtime is deterministic. Intelligence is probabilistic. The framework keeps these responsibilities separated.
