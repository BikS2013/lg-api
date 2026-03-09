/**
 * Backward Compatibility Utilities for Storage Providers
 *
 * The old repository API uses create(id, entity) while the new storage
 * interfaces use create(entity). When the registry bridges storage providers
 * to old services, the services call create(id, entity) on a storage adapter
 * that expects create(entity).
 *
 * This utility resolves the entity from either calling convention:
 *   resolveEntity(entityOrId, maybeEntity) -> entity
 */

/**
 * Resolve an entity from either create(entity) or legacy create(id, entity).
 * If the first arg is a string (the old ID pattern), the second arg is the entity.
 * Otherwise the first arg is the entity itself.
 */
export function resolveCreateArgs<T>(entityOrId: T | string, maybeEntity?: unknown): T {
  if (typeof entityOrId === 'string') {
    if (!maybeEntity) {
      throw new Error('Legacy create(id, entity) called but entity argument is missing');
    }
    return maybeEntity as T;
  }
  return entityOrId;
}
