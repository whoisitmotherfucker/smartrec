import '@shopify/shopify-api/adapters/node';
import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cookieSession from 'cookie-session';
import cors from 'cors';
import { shopifyApp } from './services/shopify';
import { authRouter } from './routes/auth';
import { webhookRouter } from './routes/webhooks';
import { apiRouter } from './routes/api';
import { publicRouter } from './routes/public';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import { startCronJobs } from './jobs';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust proxy (needed behind Railway / Render load balancer) ───────────────
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.APP_URL,
  credentials: true,
}));

// ─── Raw body for Shopify webhook HMAC verification ──────────────────────────
app.use('/webhooks', express.raw({ type: 'application/json' }));

// ─── JSON body parser (all other routes) ─────────────────────────────────────
app.use(express.json());

// ─── Session (cookie-based, signed) ──────────────────────────────────────────
app.use(cookieSession({
  name: 'smartrec_session',
  secret: process.env.SESSION_SECRET!,
  maxAge: 24 * 60 * 60 * 1000, // 24h
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'none',
}));

// ─── Health check (used by Railway) ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/webhooks', webhookRouter);
app.use('/api', apiRouter);
app.use('/public', publicRouter);  // Unauthenticated endpoints called by storefront widget

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`SmartRec server running on port ${PORT}`);
  startCronJobs();
});

export default app;
