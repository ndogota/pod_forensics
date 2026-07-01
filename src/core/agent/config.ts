// Agent runtime configuration.
//
// Free tool choice is the skill on display, but it is bounded by a max step
// count so a run always terminates.

export interface AgentConfig {
  // Maximum model turns before the loop gives up if the agent has not called
  // submit_diagnosis.
  maxSteps: number;
  // Per-response output token cap passed to the model client.
  maxTokens: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 8,
  maxTokens: 4096,
};
