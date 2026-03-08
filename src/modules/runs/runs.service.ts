/**
 * RunsService - Business logic for run management.
 *
 * Handles run lifecycle: creation, status transitions, cancellation,
 * deletion, waiting, and streaming. Coordinates with ThreadsRepository
 * to manage thread status (busy/idle) during run execution.
 */

import type { Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { RunsRepository, Run } from './runs.repository.js';
import { ThreadsRepository } from '../threads/threads.repository.js';
import { RunStreamEmitter } from './runs.streaming.js';
import { StreamManager } from '../../streaming/stream-manager.js';
import type { RunStatus, StreamMode } from '../../types/index.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';
import { ApiError } from '../../errors/api-error.js';
import type {
  RunCreateRequestSchema,
  ListRunsQuerySchema,
  CancelRunRequestSchema,
  BulkCancelRunsRequestSchema,
} from '../../schemas/run.schema.js';

type RunCreateRequest = Static<typeof RunCreateRequestSchema>;
type ListRunsQuery = Static<typeof ListRunsQuerySchema>;
type CancelRunRequest = Static<typeof CancelRunRequestSchema>;
type BulkCancelRunsRequest = Static<typeof BulkCancelRunsRequestSchema>;

/**
 * Small delay helper to simulate run execution time.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunsService {
  private streamManager: StreamManager;
  private streamEmitter: RunStreamEmitter;

  constructor(
    private runsRepository: RunsRepository,
    private threadsRepository: ThreadsRepository,
  ) {
    this.streamManager = new StreamManager();
    this.streamEmitter = new RunStreamEmitter(this.streamManager);
  }

  /**
   * Create a stateful run (associated with a thread).
   * Sets thread to busy, simulates quick completion, sets thread back to idle.
   */
  async createStateful(threadId: string, request: RunCreateRequest): Promise<Run> {
    // Verify thread exists
    const thread = await this.threadsRepository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: threadId,
      assistant_id: request.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Set thread to busy
    await this.threadsRepository.update(threadId, {
      status: 'busy',
      updated_at: nowISO(),
    });

    // Simulate quick execution: pending -> running -> success
    await this.runsRepository.update(run.run_id, {
      status: 'running',
      updated_at: nowISO(),
    });

    // Use setImmediate to simulate async completion without blocking
    setImmediate(async () => {
      try {
        await delay(100);
        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      } catch {
        // Swallow errors during background completion
      }
    });

    return created;
  }

  /**
   * Create a stateless run (no thread association).
   */
  async createStateless(request: RunCreateRequest): Promise<Run> {
    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: null,
      assistant_id: request.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Simulate quick execution
    setImmediate(async () => {
      try {
        await this.runsRepository.update(run.run_id, {
          status: 'running',
          updated_at: nowISO(),
        });
        await delay(100);
        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });
      } catch {
        // Swallow errors during background completion
      }
    });

    return created;
  }

  /**
   * Batch create multiple stateless runs.
   */
  async createBatch(requests: RunCreateRequest[]): Promise<Run[]> {
    const runs: Run[] = [];
    for (const request of requests) {
      const run = await this.createStateless(request);
      runs.push(run);
    }
    return runs;
  }

  /**
   * Get a specific run by thread ID and run ID.
   */
  async get(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }
    return run;
  }

  /**
   * List runs for a thread with pagination and optional status filtering.
   */
  async list(
    threadId: string,
    query: ListRunsQuery,
  ): Promise<{ items: Run[]; total: number; offset: number; limit: number }> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;

    const filters: Record<string, unknown> = {};
    if (query.status) {
      filters.status = query.status;
    }

    const result = await this.runsRepository.listByThreadId(threadId, {
      limit,
      offset,
      sortBy: 'created_at',
      sortOrder: 'desc',
      ...filters,
    });

    return {
      items: result.items,
      total: result.total,
      offset,
      limit,
    };
  }

  /**
   * Cancel a specific run.
   */
  async cancel(
    threadId: string,
    runId: string,
    request: CancelRunRequest,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    if (run.status === 'success' || run.status === 'error') {
      throw new ApiError(409, `Run ${runId} is already in terminal state: ${run.status}`);
    }

    await this.runsRepository.update(runId, {
      status: 'interrupted',
      updated_at: nowISO(),
    });

    // Restore thread to idle
    await this.threadsRepository.update(threadId, {
      status: 'idle',
      updated_at: nowISO(),
    });
  }

  /**
   * Bulk cancel runs matching the given criteria.
   */
  async bulkCancel(request: BulkCancelRunsRequest): Promise<void> {
    const filters: Record<string, unknown> = {};
    if (request.thread_id) filters.thread_id = request.thread_id;
    if (request.status) filters.status = request.status;

    // If specific run IDs are provided, cancel those
    if (request.run_ids && request.run_ids.length > 0) {
      for (const runId of request.run_ids) {
        const run = await this.runsRepository.getById(runId);
        if (run && run.status !== 'success' && run.status !== 'error') {
          await this.runsRepository.update(runId, {
            status: 'interrupted',
            updated_at: nowISO(),
          });
        }
      }
      return;
    }

    // Otherwise, search by filters and cancel matching runs
    const result = await this.runsRepository.search(
      { limit: 1000, offset: 0 },
      filters,
    );

    for (const run of result.items) {
      if (run.status !== 'success' && run.status !== 'error') {
        await this.runsRepository.update(run.run_id, {
          status: 'interrupted',
          updated_at: nowISO(),
        });
      }
    }
  }

  /**
   * Join a run: wait for it to reach a terminal state and return it.
   */
  async join(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    // Simulate waiting for completion
    if (run.status === 'pending' || run.status === 'running') {
      await delay(200);
      // Re-fetch to get updated status
      const updated = await this.runsRepository.getById(runId);
      if (updated) {
        return updated;
      }
    }

    return run;
  }

  /**
   * Delete a run.
   */
  async delete(threadId: string, runId: string): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    const deleted = await this.runsRepository.delete(runId);
    if (!deleted) {
      throw new ApiError(404, `Run ${runId} not found`);
    }
  }

  /**
   * Wait for a run: creates a run, waits for completion, and returns the result.
   */
  async wait(
    threadId: string | null,
    request: RunCreateRequest,
  ): Promise<{ run_id: string; thread_id: string | null; status: RunStatus; result: Record<string, unknown> }> {
    let run: Run;
    if (threadId) {
      run = await this.createStateful(threadId, request);
    } else {
      run = await this.createStateless(request);
    }

    // Simulate waiting for the run to complete
    await delay(200);

    // Re-fetch to get final status
    const completed = await this.runsRepository.getById(run.run_id);
    const finalRun = completed ?? run;

    return {
      run_id: finalRun.run_id,
      thread_id: threadId,
      status: (finalRun.status as RunStatus) || 'success',
      result: {
        messages: [
          {
            type: 'ai',
            content: 'This is a stub response from the LG-API server.',
            id: generateId(),
          },
        ],
      },
    };
  }

  /**
   * Stream a run: creates a run and streams SSE events to the client.
   */
  async streamRun(
    threadId: string | null,
    request: RunCreateRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let run: Run;
    if (threadId) {
      run = await this.createStateful(threadId, request);
    } else {
      run = await this.createStateless(request);
    }

    // Normalize stream_mode to an array
    let streamModes: StreamMode[];
    if (Array.isArray(request.stream_mode)) {
      streamModes = request.stream_mode as StreamMode[];
    } else if (request.stream_mode) {
      streamModes = [request.stream_mode as StreamMode];
    } else {
      streamModes = ['values'];
    }

    // Transition to running
    await this.runsRepository.update(run.run_id, {
      status: 'running',
      updated_at: nowISO(),
    });

    // Stream events to the client
    await this.streamEmitter.streamRun(reply, run, streamModes);

    // Transition to success after streaming
    await this.runsRepository.update(run.run_id, {
      status: 'success',
      updated_at: nowISO(),
    });

    // Restore thread to idle if stateful
    if (threadId) {
      await this.threadsRepository.update(threadId, {
        status: 'idle',
        updated_at: nowISO(),
      });
    }
  }

  /**
   * Join a run's stream: reconnect to an existing run's SSE stream.
   */
  async joinStream(
    threadId: string,
    runId: string,
    reply: FastifyReply,
    streamModes?: StreamMode[],
    lastEventId?: string,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    const modes = streamModes ?? ['values'];

    // Check if there is an existing session for replay
    if (lastEventId) {
      const existingSession = this.streamManager.getSession(runId);
      if (existingSession) {
        // Replay missed events
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const missed = this.streamManager.getEventsAfter(runId, lastEventId);
        for (const event of missed) {
          reply.raw.write(`event: ${event.event}\n`);
          reply.raw.write(`data: ${event.data}\n`);
          reply.raw.write(`id: ${event.id}\n`);
          reply.raw.write('\n');
        }
        reply.raw.end();
        return;
      }
    }

    // No existing session: stream fresh events
    await this.streamEmitter.streamRun(reply, run, modes, lastEventId);
  }
}
