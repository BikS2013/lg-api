import type { FastifyReply } from 'fastify';

/**
 * Sets pagination headers on the Fastify reply object.
 */
export function setPaginationHeaders(
  reply: FastifyReply,
  total: number,
  offset: number,
  limit: number
): void {
  reply.header('X-Pagination-Total', total.toString());
  reply.header('X-Pagination-Offset', offset.toString());
  reply.header('X-Pagination-Limit', limit.toString());
}
