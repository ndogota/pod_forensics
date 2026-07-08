// zod schema for a Diagnosis, and the terminal submit_diagnosis tool.
//
// The agent ends a run by calling submit_diagnosis with a payload shaped like
// the Diagnosis contract. The loop validates the payload against this schema,
// so a malformed diagnosis is caught rather than trusted.
//
// Single source of truth: this one schema is both what the loop validates
// against and, via z.toJSONSchema below, what submit_diagnosis advertises to the
// model. There is no second, hand-written JSON schema that could drift from it.
// The .describe() calls carry field guidance straight into that advertised
// schema, so the nudges the model sees and the rules the loop enforces are the
// same object.

import { z } from "zod";

import { ROOT_CAUSE_CLASSES, SYMPTOMS } from "../failureClasses";
import type { ToolDefinition } from "../types";

export const evidenceSchema = z.object({
  tool: z.string().describe("The tool whose output supports the claim."),
  args: z
    .record(z.string(), z.string())
    .describe("The arguments the tool was called with."),
  excerpt: z
    .string()
    .describe(
      "A short excerpt (a line or two) from that tool's output that supports the claim. Quote the specific signal, not a full dump.",
    ),
});

// The exported single source of truth. Field order is deliberate: the scalar
// required fields come first and the large evidence array comes last. suggestedFix
// and confidence are required (no .optional(), no .default(), so an omitted field
// is a validation error, not a silently filled blank), and because they precede
// the array, a turn truncated by max_tokens drops the bulky evidence first while
// these small trailing scalars still arrive intact.
export const diagnosisSchema = z.object({
  symptom: z
    .enum(SYMPTOMS)
    .describe(
      "The observable pod or service state. This is distinct from the root cause below: report what is observed here.",
    ),
  rootCauseClass: z
    .enum(ROOT_CAUSE_CLASSES)
    .describe(
      "The underlying cause; may differ from the symptom. Do not just restate the symptom: a CrashLoopBackOff can be caused by a bad command, a missing config, and so on.",
    ),
  rootCause: z
    .string()
    .min(1)
    .describe("A clear, plain-language description of the underlying cause."),
  suggestedFix: z
    .string()
    .min(1)
    .describe(
      "A short remediation suggestion. Required: always include this field. Advice only; nothing is applied.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "A number between 0 and 1 expressing confidence in this diagnosis. Required: always include this field.",
    ),
  // Every claim must be grounded, so at least one cited signal is required, and
  // at most four keeps the payload the model juggles small.
  evidence: z
    .array(evidenceSchema)
    .min(1)
    .max(4)
    .describe(
      "One to four cited signals, most discriminating first. Every claim must cite tool output; each entry quotes a short excerpt (a line or two, not a full dump) that supports it.",
    ),
});

// Render a zod validation failure as a compact, model-readable list of the
// exact field paths that failed and why. This is what a rejected submit returns
// to the model so its next attempt can be targeted, not a blind retry.
export function formatDiagnosisIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}

export const SUBMIT_DIAGNOSIS_TOOL = "submit_diagnosis";

export const submitDiagnosisDefinition: ToolDefinition = {
  name: SUBMIT_DIAGNOSIS_TOOL,
  description:
    "Submit the final diagnosis and end the run. Include the observable symptom, the root-cause class (which may differ from the symptom), the root cause in prose, a suggested fix, a confidence from 0 to 1, and an evidence entry citing the tool output for every claim. This tool does not change anything. It only records the conclusion.",
  inputSchema: z.toJSONSchema(diagnosisSchema),
};
