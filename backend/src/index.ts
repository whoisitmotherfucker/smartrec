import '@shopify/shopify-api/adapters/node';
import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cookieSession from 'cookie-session';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
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

// ─── Shopify embedded app: allow framing by Shopify admin ────────────────────
// Without this header browsers block the iframe Shopify renders our app in.
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://*.shopify.com https://admin.shopify.com;"
  );
  next();
});

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

// ─── Serve React admin UI static assets (built by Vite into backend/public) ──
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false })); // index: false so the SPA fallback handles it

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/webhooks', webhookRouter);
app.use('/api', apiRouter);
app.use('/public', publicRouter);  // Unauthenticated endpoints called by storefront widget

// ─── SPA fallback — must be AFTER all API routes ─────────────────────────────
// Serves index.html with SHOPIFY_API_KEY injected so the App Bridge CDN script
// can initialise itself via the data-api-key attribute.
app.get('*', (_req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');
  html = html.replace('__SHOPIFY_API_KEY__', process.env.SHOPIFY_API_KEY || '');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`SmartRec server running on port ${PORT}`);
  startCronJobs();
});

export default app;
