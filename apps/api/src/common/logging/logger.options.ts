import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Request } from 'express'
import type { Params } from 'nestjs-pino'
import { type LevelWithSilent, type LoggerOptions, stdTimeFunctions } from 'pino'

import type { BaseConfig } from '../config/config.js'
import { maskSensitive, maskString } from './mask.js'

const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
}

const LEVEL: Record<BaseConfig['NODE_ENV'], LevelWithSilent> = {
  development: 'debug',
  test: 'silent',
  production: 'info',
}

type LoggedRequest = IncomingMessage & Partial<Pick<Request, 'ip' | 'originalUrl'>> & { user?: { uid?: string } }

/**
 * Builds the pino options shared by the API and the worker.
 *
 * Output is one JSON object per line with `severity`, `message` and `time`, which Cloud Logging
 * parses into structured entries; in development it is pretty-printed instead. Every entry is
 * passed through {@link maskSensitive}.
 */
export function createLoggerOptions(config: BaseConfig): LoggerOptions {
  const pretty = config.NODE_ENV === 'development'

  return {
    level: LEVEL[config.NODE_ENV],
    messageKey: 'message',
    base: undefined,
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      ...(pretty ? {} : { level: (label: string) => ({ severity: SEVERITY[label] ?? 'DEFAULT' }) }),
      bindings: (bindings) => maskSensitive(bindings) as Record<string, unknown>,
      log: (object) => maskSensitive(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const masked = args.map((arg: unknown) => (typeof arg === 'string' ? maskString(arg) : arg))
        method.apply(this, masked as Parameters<typeof method>)
      },
    },
    transport: pretty
      ? { target: 'pino-pretty', options: { messageKey: 'message', singleLine: true, ignore: 'reqId' } }
      : undefined,
  }
}

/** Builds the `nestjs-pino` parameters, including one log entry per HTTP request. */
export function createLoggerParams(config: BaseConfig): Params {
  return {
    pinoHttp: {
      ...createLoggerOptions(config),
      quietReqLogger: true,
      // `httpRequest` carries the request details, so the raw request and response are not logged.
      serializers: { req: () => undefined, res: () => undefined },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      customSuccessMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,
      customErrorMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,
      customSuccessObject: (req, res, value: { responseTime: number }) => requestEntry(req, res, value.responseTime),
      customErrorObject: (req, res, err, value: { responseTime: number }) => ({
        ...requestEntry(req, res, value.responseTime),
        err,
      }),
    },
  }
}

function requestPath(req: LoggedRequest): string {
  return maskString((req.originalUrl ?? req.url ?? '').split('?')[0] ?? '')
}

function requestEntry(req: LoggedRequest, res: ServerResponse, responseTime: number) {
  return {
    httpRequest: {
      requestMethod: req.method,
      requestUrl: maskString(req.originalUrl ?? req.url ?? ''),
      status: res.statusCode,
      remoteIp: req.ip ?? req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      latency: `${(responseTime / 1000).toFixed(3)}s`,
    },
    userId: req.user?.uid,
  }
}
