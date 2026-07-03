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

import { FAILURE_CLASSES } from "../failureClasses";
import type { ToolDefinition } from "../types";

export const evidenceSchema = z.object({
  tool: z.string().describe("The tool whose output supports the claim."),
  args: z
    .record(z.string(), z.string())
    .describe("The arguments the tool was called with."),
  excerpt: z
    .string()
    .describe(
      "The specific excerpt from that tool's output that supports the claim.",
    ),
});

// The exported single source of truth. suggestedFix and confidence are required:
// no .optional() and no .default(), so an omitted field is a validation error,
// not a silently filled blank.
export const diagnosisSchema = z.object({
  failureClass: z
    .enum(FAILURE_CLASSES)
    .describe("The single best-matching failure class from the closed set."),
  rootCause: z
    .string()
    .min(1)
    .describe("A clear, plain-language description of the underlying cause."),
  // Every claim must be grounded, so at least one cited signal is required.
  evidence: z
    .array(evidenceSchema)
    .min(1)
    .describe(
      "At least one cited signal. Every claim must cite tool output; each entry quotes the excerpt that supports it.",
    ),
  suggestedFix: z
    .string()
    .min(1)
    .describe(
      "A short remediation suggestion. Required. Advice only; nothing is applied.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("A number between 0 and 1 expressing confidence in this diagnosis."),
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
    "Submit the final diagnosis and end the run. Include the failure class, the root cause, a suggested fix, a confidence from 0 to 1, and an evidence entry citing the tool output for every claim. This tool does not change anything. It only records the conclusion.",
  inputSchema: z.toJSONSchema(diagnosisSchema),
};
