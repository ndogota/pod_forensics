// zod schema for a Diagnosis, and the terminal submit_diagnosis tool.
//
// The agent ends a run by calling submit_diagnosis with a payload shaped like
// the Diagnosis contract. The loop validates the payload against this schema,
// so a malformed diagnosis is caught rather than trusted.

import { z } from "zod";

import { FAILURE_CLASSES } from "../failureClasses";
import type { ToolDefinition } from "../types";

export const evidenceSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.string()),
  excerpt: z.string(),
});

export const diagnosisSchema = z.object({
  failureClass: z.enum(FAILURE_CLASSES),
  rootCause: z.string().min(1),
  // Every claim must be grounded, so at least one cited signal is required.
  evidence: z.array(evidenceSchema).min(1),
  suggestedFix: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const SUBMIT_DIAGNOSIS_TOOL = "submit_diagnosis";

export const submitDiagnosisDefinition: ToolDefinition = {
  name: SUBMIT_DIAGNOSIS_TOOL,
  description:
    "Submit the final diagnosis and end the run. Include the failure class, the root cause, a suggested fix, a confidence from 0 to 1, and an evidence entry citing the tool output for every claim. This tool does not change anything. It only records the conclusion.",
  inputSchema: z.toJSONSchema(diagnosisSchema),
};
