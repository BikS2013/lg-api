import { Type } from '@sinclair/typebox';

// --- Thread Status ---
export const ThreadStatusEnum = Type.Union([
  Type.Literal('idle'),
  Type.Literal('busy'),
  Type.Literal('interrupted'),
  Type.Literal('error'),
]);

// --- Run Status ---
export const RunStatusEnum = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('error'),
  Type.Literal('success'),
  Type.Literal('timeout'),
  Type.Literal('interrupted'),
]);

// --- Multitask Strategy ---
export const MultitaskStrategyEnum = Type.Union([
  Type.Literal('reject'),
  Type.Literal('interrupt'),
  Type.Literal('rollback'),
  Type.Literal('enqueue'),
]);

// --- Stream Mode ---
export const StreamModeEnum = Type.Union([
  Type.Literal('values'),
  Type.Literal('updates'),
  Type.Literal('messages'),
  Type.Literal('messages-tuple'),
  Type.Literal('events'),
  Type.Literal('debug'),
  Type.Literal('custom'),
  Type.Literal('tasks'),
  Type.Literal('checkpoints'),
]);

// --- IfExists ---
export const IfExistsEnum = Type.Union([
  Type.Literal('raise'),
  Type.Literal('do_nothing'),
  Type.Literal('update'),
]);

// --- OnCompletion ---
export const OnCompletionEnum = Type.Union([
  Type.Literal('delete'),
  Type.Literal('keep'),
]);

// --- OnDisconnect ---
export const OnDisconnectEnum = Type.Union([
  Type.Literal('cancel'),
  Type.Literal('continue'),
]);

// --- Sort Order ---
export const SortOrderEnum = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
]);

// --- Durability ---
export const DurabilityEnum = Type.Union([
  Type.Literal('durable'),
  Type.Literal('ephemeral'),
]);

// --- Prune Strategy ---
export const PruneStrategyEnum = Type.Union([
  Type.Literal('delete'),
  Type.Literal('archive'),
]);

// --- Cancel Action ---
export const CancelActionEnum = Type.Union([
  Type.Literal('interrupt'),
  Type.Literal('rollback'),
]);
