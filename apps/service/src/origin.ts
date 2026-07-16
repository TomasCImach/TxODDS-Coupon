import type { FastifyRequest } from "fastify";
import type { ServiceConfig } from "./config.js";

export function requireWriteOrigin(
  request: FastifyRequest,
  config: ServiceConfig,
): string {
  const origin = request.headers.origin;
  if (origin !== config.PUBLIC_ORIGIN)
    throw new Error("request origin is not allowed");
  return origin;
}
