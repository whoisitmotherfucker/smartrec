import { Router, Request, Response } from 'express';
import { shopify } from '../services/shopify';
import { prisma } from '../utils/db';
import { logger } from '../utils/logger';
import { syncProducts } from '../services/syncService';

export const webhookRouter = Router();

// Helper: verify HMAC signature and parse body
async function verifyAndParse(req: Request, res: Response): Promise<{ shop: string; body: any } | null> {
  const hmac = req.headers['x-shopify-hmac-sha256'] as string;
  const shop = req.headers['x-shopify-shop-domain'] as string;
  const rawBody: string = (req.body as Buffer).toString();

  const valid = await shopify.webhooks.validate({
    rawBody,
    rawRequest: req,
    rawResponse: res,
  });

  if (!valid) {
    res.status(401).send('Unauthorized');
    return null;
  }

  return { shop, body: JSON.parse(rawBody) };
}

/**
 * ORDERS_CREATE — add new order to our dataset for re-training
 */
webhookRouter.post('/orders/create', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;

  const { shop, body: order } = result;
  res.status(200).send('OK');

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return;

    // Upsert the order and its line items
    const orderRecord = await prisma.order.upsert({
      where: { shopId_shopifyId: { shopId: shopRecord.id, shopifyId: String(order.id) } },
      create: {
        shopId: shopRecord.id,
        shopifyId: String(order.id),
        createdAt: new Date(order.created_at),
      },
      update: {},
    });

    for (const item of order.line_items ?? []) {
      const product = await prisma.product.findUnique({
        where: { shopId_shopifyId: { shopId: shopRecord.id, shopifyId: `gid://shopify/Product/${item.product_id}` } },
      });
      if (!product) continue;

      await prisma.orderItem.upsert({
        where: { orderId_productId: { orderId: orderRecord.id, productId: product.id } },
        create: { orderId: orderRecord.id, productId: product.id },
        update: {},
      });
    }

    logger.info(`Webhook: order ${order.id} synced for ${shop}`);
  } catch (err) {
    logger.error('Webhook orders/create failed', { shop, err });
  }
});

/**
 * PRODUCTS_UPDATE — keep product catalog fresh
 */
webhookRouter.post('/products/update', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;

  const { shop, body: product } = result;
  res.status(200).send('OK');

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return;

    await prisma.product.upsert({
      where: {
        shopId_shopifyId: {
          shopId: shopRecord.id,
          shopifyId: `gid://shopify/Product/${product.id}`,
        },
      },
      create: {
        shopId: shopRecord.id,
        shopifyId: `gid://shopify/Product/${product.id}`,
        title: product.title,
        handle: product.handle,
        imageUrl: product.image?.src ?? null,
        price: parseFloat(product.variants?.[0]?.price ?? '0'),
      },
      update: {
        title: product.title,
        handle: product.handle,
        imageUrl: product.image?.src ?? null,
        price: parseFloat(product.variants?.[0]?.price ?? '0'),
      },
    });
  } catch (err) {
    logger.error('Webhook products/update failed', { shop, err });
  }
});

/**
 * PRODUCTS_DELETE — remove from our catalog
 */
webhookRouter.post('/products/delete', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;

  const { shop, body } = result;
  res.status(200).send('OK');

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return;

    await prisma.product.deleteMany({
      where: {
        shopId: shopRecord.id,
        shopifyId: `gid://shopify/Product/${body.id}`,
      },
    });
  } catch (err) {
    logger.error('Webhook products/delete failed', { shop, err });
  }
});

/**
 * APP_UNINSTALLED — mark shop as uninstalled, stop billing
 */
webhookRouter.post('/app/uninstalled', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;

  const { shop } = result;
  res.status(200).send('OK');

  await prisma.shop.updateMany({
    where: { shopDomain: shop },
    data: { uninstalledAt: new Date(), billingId: null },
  });

  logger.info(`App uninstalled: ${shop}`);
});

// ─── Compliance webhook dispatcher ───────────────────────────────────────────
// Shopify routes all three GDPR topics to /webhooks/compliance.
// The x-shopify-topic header tells us which one fired.
webhookRouter.post('/compliance', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;

  const topic = (req.headers['x-shopify-topic'] as string ?? '').toLowerCase();
  res.status(200).send('OK');

  const { shop, body } = result;
  logger.info(`GDPR compliance webhook: ${topic}`, { shop });

  if (topic === 'customers/data_request') {
    // We store no customer PII — nothing to return.
  } else if (topic === 'customers/redact') {
    // Analytics events keyed by sessionId only, not customer identity — nothing to redact.
    logger.info('GDPR customers/redact: no PII stored', { shop });
  } else if (topic === 'shop/redact') {
    try {
      const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
      if (shopRecord) {
        await prisma.analyticsEvent.deleteMany({ where: { shopId: shopRecord.id } });
        await prisma.recommendation.deleteMany({ where: { shopId: shopRecord.id } });
        await prisma.orderItem.deleteMany({ where: { order: { shopId: shopRecord.id } } });
        await prisma.order.deleteMany({ where: { shopId: shopRecord.id } });
        await prisma.product.deleteMany({ where: { shopId: shopRecord.id } });
        await prisma.widgetConfig.deleteMany({ where: { shopId: shopRecord.id } });
        await prisma.shop.delete({ where: { id: shopRecord.id } });
        logger.info(`GDPR shop/redact complete: all data deleted for ${shop}`);
      }
    } catch (err) {
      logger.error('GDPR shop/redact error', { shop, err });
    }
  }
});

// ─── GDPR Webhooks (required for Shopify App Store approval) ─────────────────
// Individual routes kept for backward compatibility.
// SmartRec stores no customer PII; only shop-level aggregate analytics.

/**
 * CUSTOMERS_DATA_REQUEST
 * Merchant's customer asked for their data. We don't store PII so we respond 200.
 */
webhookRouter.post('/customers/data_request', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;
  res.status(200).send('OK');
  logger.info('GDPR: customers/data_request received', { shop: result.shop });
  // SmartRec does not store customer PII (names, emails, addresses).
  // Analytics events are stored by sessionId only — not linked to customer identity.
});

/**
 * CUSTOMERS_REDACT
 * Merchant's customer requested erasure. Delete analytics events for this session.
 */
webhookRouter.post('/customers/redact', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;
  res.status(200).send('OK');

  const { shop, body } = result;
  logger.info('GDPR: customers/redact received', { shop });

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return;

    // orders_to_redact contains order IDs — we don't store customer PII but
    // we can delete analytics events associated with those orders' sessions.
    const orderIds: string[] = (body.orders_to_redact ?? []).map((o: any) => String(o.id));
    if (orderIds.length > 0) {
      // We only have sessionId, not orderId, in AnalyticsEvent — nothing to redact.
      // Log for audit trail.
      logger.info('GDPR customers/redact: no PII to delete', { shop, orderIds });
    }
  } catch (err) {
    logger.error('GDPR customers/redact error', { shop, err });
  }
});

/**
 * SHOP_REDACT
 * Shop uninstalled + 48h grace period passed. Delete all shop data.
 */
webhookRouter.post('/shop/redact', async (req, res) => {
  const result = await verifyAndParse(req, res);
  if (!result) return;
  res.status(200).send('OK');

  const { shop } = result;
  logger.info('GDPR: shop/redact received', { shop });

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return;

    // Cascade-delete all shop data in dependency order
    await prisma.analyticsEvent.deleteMany({ where: { shopId: shopRecord.id } });
    await prisma.recommendation.deleteMany({ where: { shopId: shopRecord.id } });
    await prisma.orderItem.deleteMany({ where: { order: { shopId: shopRecord.id } } });
    await prisma.order.deleteMany({ where: { shopId: shopRecord.id } });
    await prisma.product.deleteMany({ where: { shopId: shopRecord.id } });
    await prisma.widgetConfig.deleteMany({ where: { shopId: shopRecord.id } });
    await prisma.shop.delete({ where: { id: shopRecord.id } });

    logger.info(`GDPR shop/redact complete: all data deleted for ${shop}`);
  } catch (err) {
    logger.error('GDPR shop/redact error', { shop, err });
  }
});
