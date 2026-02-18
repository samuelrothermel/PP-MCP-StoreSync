require('dotenv').config();
const express = require('express');
const path = require('path');
const { loadCatalog } = require('./services/catalog');
const cartRoutes = require('./routes/cart');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Product Catalog ─────────────────────────────────────────────────────────
// PayPal Store Sync fetches this URL as the catalog source.
// Configure Store Sync with:
//   Source URL : https://pp-store-sync.up.railway.app/catalog/product_catalog.csv
//   File format: CSV
app.get('/catalog/product_catalog.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'product_catalog.csv'));
});

// ─── Merchant Cart API ────────────────────────────────────────────────────────
// PayPal calls these endpoints during agentic checkout:
//   POST   /api/paypal/v1/merchant-cart            create cart
//   PUT    /api/paypal/v1/merchant-cart/:id         update cart
//   POST   /api/paypal/v1/merchant-cart/:id/checkout  complete checkout
app.use('/api/paypal/v1', cartRoutes);

// ─── Health / Info ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    service: 'PP Store Sync Merchant API',
    environment: process.env.PAYPAL_ENVIRONMENT || 'SANDBOX',
    endpoints: {
      catalog: `${base}/catalog/product_catalog.csv`,
      create_cart: `POST ${base}/api/paypal/v1/merchant-cart`,
      update_cart: `PUT  ${base}/api/paypal/v1/merchant-cart/:id`,
      checkout: `POST ${base}/api/paypal/v1/merchant-cart/:id/checkout`,
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadCatalog();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Catalog URL : http://localhost:${PORT}/catalog/product_catalog.csv`);
  console.log(`Cart API    : http://localhost:${PORT}/api/paypal/v1/merchant-cart`);
});
