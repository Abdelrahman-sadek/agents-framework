# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/Abdelrahman-sadek/agents-framework/security/advisories/new)
and include a description, affected versions or commits, and steps to reproduce.

You should receive an acknowledgement within a few days. Fixes are released as soon as practical and
credited in the changelog unless you prefer otherwise.

## Scope

In scope: anything that lets a model, user, tenant or tool bypass the framework's deterministic controls, for example:

- executing a tool without authorization, approval, or schema validation;
- escalating permissions through an agent or across tenants;
- exceeding configured limits (steps, tool calls, tokens, cost, timeouts);
- leaking tool metadata, secrets, sensitive inputs or raw exception text to a model or to telemetry.

The security model and threat model are documented in [docs/security](./docs/security/README.md).

## Supported versions

The project is pre-1.0. Security fixes land on `main`.
