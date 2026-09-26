# Extension points

This document describes architectural extension points the framework is designed to support, even when they are not fully implemented yet.

## Decision engine

The framework should support deterministic decisioning independently from LLM reasoning.

```
Application
  ↓
Decision Engine
  ↓
Decision Provider
```

Possible future decision providers:

- deterministic rules
- local models
- LLM judge
- custom decision provider

Future uses:

- routing
- classification
- ranking
- verification
- guard decisions
- prompt-injection detection
- destructive-action gating
- context compaction decisions
- parts of evaluation

The binding rule is that deterministic decisions must remain deterministic. The LLM may assist, but it must not be the authoritative runtime decision maker for security-critical or irreversible actions.

## Context management

Context management should not mean “send everything into the prompt.”

```
ContextManager
  ↓
selection
  ↓
ranking
  ↓
deduplication
  ↓
compression
  ↓
summarization
  ↓
token budgeting
  ↓
provenance
```

The framework should support context policies such as:

- max tokens
- include memory
- include tool history
- summarize history after N turns

## Skills

Skills should be reusable, composable capabilities, not giant prompt strings.

A future Skill should be able to declare:

- name
- description
- input schema
- output schema
- instructions
- required tools
- permissions
- dependencies
- examples
- evaluation requirements

Skills should integrate with the existing agent/tool abstractions without making them awkward.

## Sandbox

Eventually the framework will need controlled execution environments.

Potential capabilities:

- filesystem
- shell
- git
- network
- workspace
- process/resource limits

These must remain security-controlled capabilities. The LLM must never receive unrestricted operating-system authority.

## Model router

The LLM abstraction should eventually support capability metadata so a model router can choose models based on:

- task requirements
- model capabilities
- cost
- latency
- local availability
- hardware constraints

Phase 1 keeps this simple. Future phases can add a stronger model router without redesigning the provider abstraction.

## Tool adapters

The internal tool abstraction is framework-owned. Future adapters may include:

- Native Tool
- HTTP Tool
- Database Tool
- Filesystem Tool
- Sandbox Tool
- MCP Tool
- Custom Tool

MCP must remain an adapter, not the internal tool representation.

## Ecosystem awareness

External projects may inspire adapters or architectural improvements, but the framework must own its own stable abstractions.

New projects should be evaluated before adoption using:

1. maturity
2. maintenance activity
3. license
4. security
5. architecture
6. performance
7. community
8. vendor lock-in
9. API stability
10. whether the project solves a real framework problem

Do not add a dependency merely because it is trending.
