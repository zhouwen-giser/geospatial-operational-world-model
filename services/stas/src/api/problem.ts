import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, mapDatabaseError } from '../domain/errors.js';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  [key: string]: unknown;
}

export function toProblem(error: unknown, instance: string): ProblemDetails {
  const mapped = error instanceof AppError ? error : mapDatabaseError(error);
  return {
    type: `https://stas.example/problems/${mapped.code.toLowerCase().replaceAll('_', '-')}`,
    title: mapped.title,
    status: mapped.status,
    detail: mapped.message,
    instance,
    code: mapped.code,
    ...mapped.meta,
  };
}

export function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): void {
  const problem = toProblem(error, request.url);
  void reply.type('application/problem+json').status(problem.status).send(problem);
}
