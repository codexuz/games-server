import { IS_PROD } from '../config/env.js';

export function errorHandler(err, req, res, _next) {
  const status = err.status ?? err.statusCode ?? 500;
  const message = IS_PROD && status >= 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
}

// Wraps a socket event handler so unhandled throws emit 'error' to the client
// instead of crashing the process silently.
export function socketHandler(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      const socket = args.find(a => a?.emit);
      if (socket) socket.emit('error', 'Unexpected server error');
      console.error('[socket error]', err);
    }
  };
}
