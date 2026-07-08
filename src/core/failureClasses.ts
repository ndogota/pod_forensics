// The closed taxonomy as runtime values.
//
// types.ts declares Symptom and RootCauseClass as frozen union types. A zod enum
// and a few runtime checks need the same sets as arrays, so they live here. The
// compile-time assignments below keep each array in sync with its union: if an
// array and its union ever drift, this file stops compiling.

import type { RootCauseClass, Symptom } from "./types";

// The observable pod or service state.
export const SYMPTOMS = [
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "OOMKilled",
  "Pending",
  "RunningDegraded",
  "ServiceNoEndpoints",
] as const;

// The underlying cause; may differ from the symptom.
export const ROOT_CAUSE_CLASSES = [
  "BadCommand",
  "MissingConfigOrSecret",
  "ImageUnavailable",
  "InsufficientResources",
  "MemoryLimitExceeded",
  "ProbeMisconfigured",
  "SelectorLabelMismatch",
  "RbacDenied",
] as const;

// Compile-time guards: each array must cover exactly its union.
type SymptomMember = (typeof SYMPTOMS)[number];
const _symptomsSame: Symptom extends SymptomMember
  ? SymptomMember extends Symptom
    ? true
    : never
  : never = true;
void _symptomsSame;

type CauseMember = (typeof ROOT_CAUSE_CLASSES)[number];
const _causesSame: RootCauseClass extends CauseMember
  ? CauseMember extends RootCauseClass
    ? true
    : never
  : never = true;
void _causesSame;
