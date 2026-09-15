import type {
  AgentDispatchNotification,
  AgentStreamNotification,
  TriggerProvider,
  TriggerProviderLifecycleResult,
  TriggerProviderReactionState,
} from "./index.js";

export async function notifyDispatchAccepted(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  reactionState?: TriggerProviderReactionState;
}): Promise<TriggerProviderReactionState> {
  const result = await input.provider.onDispatchAccepted?.(
    input.triggerContext,
    input.outputContext,
    input.reactionState,
  );
  return retainReactionState(input.reactionState, result);
}

export async function notifyAgentExecutionStarted(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  reactionState?: TriggerProviderReactionState;
}): Promise<TriggerProviderReactionState> {
  const result = await input.provider.onAgentExecutionStarted?.(
    input.triggerContext,
    input.outputContext,
    input.reactionState,
  );
  return retainReactionState(input.reactionState, result);
}

export async function notifyAgentExecutionCompleted(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  result: TriggerProviderLifecycleResult;
  reactionState?: TriggerProviderReactionState;
}): Promise<TriggerProviderReactionState> {
  const result = await input.provider.onAgentExecutionCompleted?.(
    input.triggerContext,
    input.outputContext,
    input.result,
    input.reactionState,
  );
  return retainReactionState(input.reactionState, result);
}

export async function notifyAgentExecutionFailed(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  reason: string;
  reactionState?: TriggerProviderReactionState;
}): Promise<TriggerProviderReactionState> {
  const result = await input.provider.onAgentExecutionFailed?.(
    input.triggerContext,
    input.outputContext,
    input.reason,
    input.reactionState,
  );
  return retainReactionState(input.reactionState, result);
}

export async function notifyAgentExecutionTerminal(input: {
  provider: TriggerProvider;
  executionId: string;
  triggerContext: unknown;
}): Promise<void> {
  await input.provider.onAgentExecutionTerminal?.(input.executionId, input.triggerContext);
}

/** No reaction state: the daemon agent identity lives on the execution, not on the reaction. */
export async function notifyAgentDispatched(input: {
  provider: TriggerProvider;
  notification: AgentDispatchNotification;
}): Promise<void> {
  await input.provider.onAgentDispatched?.(input.notification);
}

/** No reaction state: stream events are too frequent to round-trip through the execution row. */
export async function notifyAgentStreamEvent(input: {
  provider: TriggerProvider;
  notification: AgentStreamNotification;
}): Promise<void> {
  await input.provider.onAgentStreamEvent?.(input.notification);
}

export async function notifyMachineTerminated(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  reason: string;
  reactionState?: TriggerProviderReactionState;
}): Promise<TriggerProviderReactionState> {
  const result = await input.provider.onMachineTerminated?.(
    input.triggerContext,
    input.reason,
    input.reactionState,
  );
  return retainReactionState(input.reactionState, result);
}

function retainReactionState(
  previous: TriggerProviderReactionState | undefined,
  result: TriggerProviderReactionState | void,
): TriggerProviderReactionState {
  return result === undefined ? (previous ?? null) : result;
}
