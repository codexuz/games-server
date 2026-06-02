import 'dotenv/config';
import { PORT, CORS_ORIGIN, IS_PROD } from './src/config/env.js';

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import pino from 'pino';

import prisma from './prisma.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import { registerSocketHandlers } from './src/services/gameEngine.js';

import authRouter from './src/routes/auth.js';
import quizzesRouter from './src/routes/quizzes.js';
import templatesRouter from './src/routes/templates.js';
import analyticsRouter from './routes/analytics.js';
import leaderboardRouter from './routes/leaderboard.js';
import aiRouter from './src/routes/ai.js';

const logger = pino({ level: IS_PROD ? 'info' : 'debug' });

const app = express();

app.use(helmet());
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));

// Stricter rate limiting on auth endpoints
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
}));

// General API rate limit
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Health check — for load balancers and uptime monitors
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected', uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/teacher/quizzes', quizzesRouter);   // backwards-compat alias
app.use('/api/templates', templatesRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/ai', aiRouter);

app.use(errorHandler);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  httpServer.close(async () => {
    await prisma.$disconnect();
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
