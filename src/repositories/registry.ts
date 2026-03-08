/**
 * Repository Registry
 *
 * Centralized singleton registry of all repositories.
 * Ensures that all route modules share the same repository instances,
 * so data created in one module is visible to others.
 */

import { AssistantsRepository } from '../modules/assistants/assistants.repository.js';
import { ThreadsRepository } from '../modules/threads/threads.repository.js';
import { RunsRepository } from '../modules/runs/runs.repository.js';
import { CronsRepository } from '../modules/crons/crons.repository.js';
import { StoreRepository } from '../modules/store/store.repository.js';

export interface RepositoryRegistry {
  assistants: AssistantsRepository;
  threads: ThreadsRepository;
  runs: RunsRepository;
  crons: CronsRepository;
  store: StoreRepository;
}

let registry: RepositoryRegistry | null = null;

export function getRepositoryRegistry(): RepositoryRegistry {
  if (!registry) {
    registry = {
      assistants: new AssistantsRepository(),
      threads: new ThreadsRepository(),
      runs: new RunsRepository(),
      crons: new CronsRepository(),
      store: new StoreRepository(),
    };
  }
  return registry;
}

export function resetRepositoryRegistry(): void {
  registry = null;
}
