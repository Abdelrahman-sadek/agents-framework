import type { ContextProvider } from "./context.js";
import { ConfigurationError } from "./errors.js";
import type { Guardrail } from "./guardrail.js";
import type { Verifier } from "./reflection.js";
import type { AgentTool } from "./tool.js";

/**
 * A skill is a reusable, testable capability: scoped instructions plus the
 * tools, permissions, context, guardrails and verifiers it needs, its
 * dependencies, worked examples and the evaluation cases it must pass.
 * Skills compose into agents; they are not giant prompt strings.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly instructions: string;
  readonly tools?: readonly AgentTool[];
  readonly permissions?: readonly string[];
  readonly context?: readonly ContextProvider[];
  readonly guardrails?: readonly Guardrail[];
  readonly verifiers?: readonly Verifier[];
  readonly dependsOn?: readonly Skill[];
  readonly examples?: readonly { input: string; output: string }[];
  /** Cases the skill must pass (consumed by `skillDataset` in @agent-farmework/evaluation). */
  readonly evaluation?: { readonly cases: readonly { id: string; input: unknown; expected?: unknown }[]; readonly minPassRate?: number };
}

const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function defineSkill(skill: Skill): Skill {
  if (!SKILL_NAME.test(skill.name)) throw new ConfigurationError(`Skill name '${skill.name}' must match ${SKILL_NAME.source}`);
  if (skill.description.trim() === "" || skill.instructions.trim() === "") {
    throw new ConfigurationError(`Skill '${skill.name}' needs a description and instructions`);
  }
  return Object.freeze({ ...skill });
}

/** Skills in dependency order (dependencies first), deduplicated by name. Cycles are rejected. */
export function resolveSkills(skills: readonly Skill[]): Skill[] {
  const ordered: Skill[] = [];
  const done = new Map<string, Skill>();
  const visiting = new Set<string>();
  const visit = (skill: Skill): void => {
    const seen = done.get(skill.name);
    if (seen !== undefined) {
      if (seen !== skill) throw new ConfigurationError(`Two different skills are named '${skill.name}'`);
      return;
    }
    if (visiting.has(skill.name)) throw new ConfigurationError(`Skill dependency cycle through '${skill.name}'`);
    visiting.add(skill.name);
    for (const dep of skill.dependsOn ?? []) visit(dep);
    visiting.delete(skill.name);
    done.set(skill.name, skill);
    ordered.push(skill);
  };
  for (const s of skills) visit(s);
  return ordered;
}

export function renderSkillInstructions(skill: Skill): string {
  const examples = (skill.examples ?? []).map((e) => `Example input: ${e.input}\nExample output: ${e.output}`).join("\n\n");
  return `## Skill: ${skill.name}\n${skill.description}\n\n${skill.instructions}${examples === "" ? "" : `\n\n${examples}`}`;
}
