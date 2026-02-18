const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { verifyPayPalToken } = require('../middleware/auth');
const { createOrder, patchOrder, captureOrder } = require('../services/paypal');
const { getCatalogMap } = require('../services/catalog');

const router = express.Router();

// In-memory cart store (sufficient for sandbox demo; replace with DB for production)
const carts = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundUSD(n) {
  return parseFloat(n.toFixed(2)).toFixed(2);
}

function calculateTotals(items) {
  const subtotal = items.reduce((sum, i) => sum + parseFloat(i.unit_amount.value) * i.quantity, 0);
  const shipping = subtotal >= 50 ? 0 : 5.99;
  const tax = subtotal * 0.08;
  const total = subtotal + shipping + tax;
  return {
    subtotal: { currency_code: 'USD', value: roundUSD(subtotal) },
    shipping: { currency_code: 'USD', value: roundUSD(shipping) },
    tax: { currency_code: 'USD', value: roundUSD(tax) },
    total: { currency_code: 'USD', value: roundUSD(total) },
  };
}

function validateAndEnrichItems(requestedItems) {
  const catalog = getCatalogMap();
  const validationIssues = [];
  const enrichedItems = [];

  for (const item of requestedItems) {
    const product = catalog.get(item.variant_id);

    if (!product) {
      validationIssues.push({
        code: 'INVENTORY_ISSUE',
        type: 'INVALID_DATA',
        message: `Product variant ${item.variant_id} not found in catalog`,
        variant_id: item.variant_id,
        context: { specific_issue: 'ITEM_NOT_FOUND' },
      });
      continue;
    }

    if (product.availability === 'out_of_stock') {
      validationIssues.push({
        code: 'INVENTORY_ISSUE',
        type: 'BUSINESS_RULE',
        message: `${product.title} is currently out of stock`,
        user_message: `${product.title} is out of stock. Would you like to try a similar item?`,
        variant_id: item.variant_id,
        context: { specific_issue: 'ITEM_OUT_OF_STOCK', available_quantity: 0, requested_quantity: item.quantity },
        resolution_options: [{ action: 'REMOVE_ITEM', label: 'Remove from cart' }],
      });
    }

    enrichedItems.push({
      variant_id: item.variant_id,
      quantity: item.quantity,
      name: item.name || product.title,
      unit_amount: { currency_code: 'USD', value: product.price },
      item_total: { currency_code: 'USD', value: roundUSD(parseFloat(product.price) * item.quantity) },
    });
  }

  return { enrichedItems, validationIssues };
}

function buildCartStatus(validationIssues, hasShipping) {
  if (validationIssues.length > 0) {
    const hasInvalid = validationIssues.some((i) => i.type === 'BUSINESS_RULE');
    return {
      status: 'INCOMPLETE',
      validation_status: hasInvalid ? 'INVALID' : 'REQUIRES_ADDITIONAL_INFORMATION',
    };
  }
  if (!hasShipping) {
    return { status: 'INCOMPLETE', validation_status: 'REQUIRES_ADDITIONAL_INFORMATION' };
  }
  return { status: 'CREATED', validation_status: 'VALID' };
}

// ─── POST /merchant-cart ─────────────────────────────────────────────────────

router.post('/merchant-cart', verifyPayPalToken, async (req, res) => {
  try {
    const { items = [], shipping_address, customer, payment_method, checkout_fields } = req.body;

    if (!items.length) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }

    const { enrichedItems, validationIssues } = validateAndEnrichItems(items);
    const totals = calculateTotals(enrichedItems);
    const { status, validation_status } = buildCartStatus(validationIssues, !!shipping_address);

    // Create a PayPal Orders v2 order to obtain the payment token
    const cartForOrder = { items: enrichedItems, totals, shipping_address };
    const paypalOrder = await createOrder(cartForOrder);

    const cart = {
      id: `CART-${uuidv4().toUpperCase().slice(0, 8)}`,
      status,
      validation_status,
      validation_issues: validationIssues,
      items: enrichedItems,
      totals,
      customer: customer || null,
      shipping_address: shipping_address || null,
      checkout_fields: checkout_fields || [],
      payment_method: {
        type: 'PAYPAL',
        token: paypalOrder.id,
      },
      paypal_order_id: paypalOrder.id,
      created_at: new Date().toISOString(),
    };

    carts.set(cart.id, cart);

    const httpStatus = validationIssues.length > 0 ? 200 : 201;
    return res.status(httpStatus).json(cart);
  } catch (err) {
    console.error('[POST /merchant-cart]', err.message);
    return res.status(500).json({ error: 'Failed to create cart', detail: err.message });
  }
});

// ─── PUT /merchant-cart/:id ──────────────────────────────────────────────────

router.put('/merchant-cart/:id', verifyPayPalToken, async (req, res) => {
  try {
    const existing = carts.get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: `Cart ${req.params.id} not found` });
    }
    if (existing.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Cannot update a completed cart' });
    }

    const { items = [], shipping_address, customer, payment_method, checkout_fields } = req.body;

    if (!items.length) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }

    const { enrichedItems, validationIssues } = validateAndEnrichItems(items);
    const totals = calculateTotals(enrichedItems);
    const { status, validation_status } = buildCartStatus(validationIssues, !!shipping_address);

    await patchOrder(existing.paypal_order_id, { totals });

    const updated = {
      ...existing,
      status,
      validation_status,
      validation_issues: validationIssues,
      items: enrichedItems,
      totals,
      customer: customer ?? existing.customer,
      shipping_address: shipping_address ?? existing.shipping_address,
      checkout_fields: checkout_fields ?? existing.checkout_fields,
      payment_method: existing.payment_method,
      updated_at: new Date().toISOString(),
    };

    carts.set(updated.id, updated);
    return res.status(200).json(updated);
  } catch (err) {
    console.error(`[PUT /merchant-cart/${req.params.id}]`, err.message);
    return res.status(500).json({ error: 'Failed to update cart', detail: err.message });
  }
});

// ─── POST /merchant-cart/:id/checkout ────────────────────────────────────────

router.post('/merchant-cart/:id/checkout', verifyPayPalToken, async (req, res) => {
  try {
    const cart = carts.get(req.params.id);
    if (!cart) {
      return res.status(404).json({ error: `Cart ${req.params.id} not found` });
    }
    if (cart.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Cart is already completed' });
    }
    if (cart.validation_status !== 'VALID') {
      return res.status(200).json({
        ...cart,
        error: 'Cart has unresolved validation issues and cannot be checked out',
      });
    }

    const captureResult = await captureOrder(cart.paypal_order_id);

    const orderId = `ORDER-${uuidv4().toUpperCase().slice(0, 8)}`;
    const completed = {
      ...cart,
      status: 'COMPLETED',
      validation_status: 'VALID',
      validation_issues: [],
      payment_confirmation: {
        merchant_order_number: orderId,
        paypal_order_id: captureResult.id,
        paypal_status: captureResult.status,
        order_review_page: `${process.env.STORE_URL || 'https://www.pp-store-sync.railway.app'}/orders/${orderId}`,
      },
      completed_at: new Date().toISOString(),
    };

    carts.set(completed.id, completed);
    return res.status(200).json(completed);
  } catch (err) {
    console.error(`[POST /merchant-cart/${req.params.id}/checkout]`, err.message);
    return res.status(500).json({ error: 'Checkout failed', detail: err.message });
  }
});

module.exports = router;
