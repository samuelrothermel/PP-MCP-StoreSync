import axios from 'axios';

const BASE_URL =
  process.env.PAYPAL_ENVIRONMENT === 'PRODUCTION'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in environment');
  }

  const resp = await axios.post(
    `${BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  cachedToken = resp.data.access_token;
  tokenExpiresAt = Date.now() + (resp.data.expires_in - 60) * 1000;
  return cachedToken;
}

function buildPurchaseUnit(cart) {
  const subtotal = cart.totals.subtotal.value;
  const shipping = cart.totals.shipping.value;
  const tax = cart.totals.tax.value;
  const total = cart.totals.total.value;

  return {
    reference_id: 'default',
    amount: {
      currency_code: 'USD',
      value: total,
      breakdown: {
        item_total: { currency_code: 'USD', value: subtotal },
        shipping: { currency_code: 'USD', value: shipping },
        tax_total: { currency_code: 'USD', value: tax },
      },
    },
    items: cart.items.map((item) => ({
      name: item.name,
      unit_amount: { currency_code: 'USD', value: item.unit_amount.value },
      quantity: String(item.quantity),
      sku: item.variant_id,
    })),
    ...(cart.shipping_address && {
      shipping: {
        address: {
          address_line_1: cart.shipping_address.address_line_1,
          admin_area_2: cart.shipping_address.admin_area_2,
          admin_area_1: cart.shipping_address.admin_area_1,
          postal_code: cart.shipping_address.postal_code,
          country_code: cart.shipping_address.country_code || 'US',
        },
      },
    }),
  };
}

export async function createOrder(cart) {
  const token = await getAccessToken();
  const resp = await axios.post(
    `${BASE_URL}/v2/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [buildPurchaseUnit(cart)],
      payment_source: { paypal: {} },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

export async function patchOrder(orderId, cart) {
  const token = await getAccessToken();
  await axios.patch(
    `${BASE_URL}/v2/orders/${orderId}`,
    [
      {
        op: 'replace',
        path: "/purchase_units/@reference_id=='default'/amount",
        value: {
          currency_code: 'USD',
          value: cart.totals.total.value,
          breakdown: {
            item_total: { currency_code: 'USD', value: cart.totals.subtotal.value },
            shipping: { currency_code: 'USD', value: cart.totals.shipping.value },
            tax_total: { currency_code: 'USD', value: cart.totals.tax.value },
          },
        },
      },
    ],
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

export async function captureOrder(orderId) {
  const token = await getAccessToken();
  const resp = await axios.post(
    `${BASE_URL}/v2/orders/${orderId}/capture`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}
