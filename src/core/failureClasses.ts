// The closed failure set as a runtime value.
//
// types.ts declares FailureClass as a frozen union type. A zod enum and a few
// runtime checks need the same set as an array, so it lives here. The
// compile-time assignment below keeps the two in sync: if the array and the
// union ever drift, this file stops compiling.

import type { FailureClass } from "./types";

export const FAILURE_CLASSES = [
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "OOMKilled",
  "ProbeMisconfigured",
  "PodUnschedulable",
  "ServiceNoEndpoints",
  "MissingConfigOrSecret",
  "RbacDenied",
] as const;

// Compile-time guard: the array must cover exactly the FailureClass union.
type ArrayMember = (typeof FAILURE_CLASSES)[number];
const _sameType: FailureClass extends ArrayMember
  ? ArrayMember extends FailureClass
    ? true
    : never
  : never = true;
void _sameType;
