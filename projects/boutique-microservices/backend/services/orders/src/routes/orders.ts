import express from 'express';
import axios from 'axios';
import { query } from '../database/connection';
import { requireUser, requireAdmin } from '../auth';
import { Order, CreateOrderRequest, Address, ServiceResponse } from '../types';

const router = express.Router();
const PRODUCTS_SERVICE_URL = process.env.PRODUCTS_SERVICE_URL || 'http://localhost:3003';
const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

// Pricing rules shown in the cart; the server is the source of truth.
const FREE_SHIPPING_OVER = 500;
const SHIPPING_FEE = 15;
const TAX_RATE = 0.08;
const cents = (n: number) => Math.round(n * 100) / 100;

function priceTotals(subtotal: number) {
  const shipping = subtotal > FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
  const tax = cents(subtotal * TAX_RATE);
  return { subtotal: cents(subtotal), shipping, tax, total: cents(subtotal + shipping + tax) };
}

function parseAddress(value: any) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return { street: value }; }
}

// Product from product-service, or null if it doesn't exist.
async function fetchProduct(productId: string) {
  try {
    const res = await axios.get(`${PRODUCTS_SERVICE_URL}/${productId}`);
    return res.data.data;
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 404 || status === 400 || status === 500) return null; // product-service returns 500 for malformed IDs
    throw err;
  }
}

router.post('/', requireUser, async (req, res) => {
  try {
    // The user comes from the verified token, never from the request body.
    const userId = res.locals.user.userId;
    const { items, shippingAddress } = req.body as CreateOrderRequest;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Order must contain at least one item' });
    }
    if (!items.every(i => Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= 100)) {
      return res.status(400).json({ success: false, error: 'Each quantity must be a whole number from 1 to 100' });
    }

    let subtotal = 0;
    const orderItems: any[] = [];

    for (const item of items) {
      const product = await fetchProduct(item.productId);
      if (!product) {
        return res.status(400).json({ success: false, error: `Product not found: ${item.productId}` });
      }

      subtotal += Number(product.price) * item.quantity;

      orderItems.push({
        product_id: item.productId,
        quantity: item.quantity,
        price: product.price
      });
    }

    const result = await query(`
      INSERT INTO orders (user_id, total_amount, status, shipping_address, payment_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `, [userId, priceTotals(subtotal).total, 'pending', JSON.stringify(shippingAddress), 'pending']);

    const order = result.rows[0];

    const insertedItems: any[] = [];
    for (const item of orderItems) {
      const itemResult = await query(`
        INSERT INTO order_items (order_id, product_id, quantity, price)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [order.id, item.product_id, item.quantity, item.price]);
      insertedItems.push({ ...item, id: itemResult.rows[0].id });
    }

    const response: ServiceResponse<Order> = {
      success: true,
      data: {
        id: order.id,
        userId: order.user_id,
        items: insertedItems.map(item => ({
          id: item.id,
          orderId: order.id,
          productId: item.product_id,
          quantity: item.quantity,
          price: item.price
        })),
        totalAmount: Number(order.total_amount),
        status: order.status,
        shippingAddress: shippingAddress,
        paymentStatus: order.payment_status,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      }
    };

    res.status(201).json(response);
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
});

router.get('/my-orders', requireUser, async (req, res) => {
  try {
    const userId = res.locals.user.userId;

    const result = await query(`
      SELECT o.*,
             JSON_AGG(
               JSON_BUILD_OBJECT(
                 'id', oi.id,
                 'productId', oi.product_id,
                 'quantity', oi.quantity,
                 'price', oi.price
               )
             ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = $1
      GROUP BY o.id, o.user_id, o.total_amount, o.status, o.shipping_address, o.payment_status, o.created_at, o.updated_at
      ORDER BY o.created_at DESC
    `, [userId]);

    // Attach product name and image to each item (one lookup per distinct product).
    const productIds = Array.from(new Set(
      result.rows.flatMap((o: any) => (o.items || []).filter((i: any) => i && i.productId).map((i: any) => i.productId))
    )) as string[];
    const products = new Map<string, any>();
    await Promise.all(productIds.map(async id => products.set(id, await fetchProduct(id))));

    const orders = result.rows.map((o: any) => ({
      id: o.id,
      userId: o.user_id,
      items: (o.items || []).filter((i: any) => i && i.id).map((i: any) => {
        const p = products.get(i.productId);
        return {
          ...i,
          product: { id: i.productId, name: p?.name ?? 'Unavailable product', imageUrl: p?.image_url ?? '' },
        };
      }),
      totalAmount: Number(o.total_amount),
      status: o.status,
      shippingAddress: parseAddress(o.shipping_address),
      paymentStatus: o.payment_status,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }));

    const response: ServiceResponse<Order[]> = {
      success: true,
      data: orders
    };

    res.json(response);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to get orders' });
  }
});

router.patch('/:id/status', requireUser, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `Status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }

    await query('UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, id]);

    const result = await query('SELECT * FROM orders WHERE id = $1', [id]);

    const response: ServiceResponse<Order> = {
      success: true,
      data: result.rows[0]
    };

    res.json(response);
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update order status' });
  }
});

export { router as orderRoutes };
