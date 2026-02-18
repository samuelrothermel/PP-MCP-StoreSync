import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let catalogMap = null;

/**
 * Loads product_catalog.csv into a Map keyed by variant id.
 * Called once at server startup.
 */
export function loadCatalog() {
  const csvPath = path.join(__dirname, '..', 'product_catalog.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(Boolean);

  // Skip header row
  const [, ...rows] = lines;

  catalogMap = new Map();
  for (const row of rows) {
    // Split on comma, but respect quoted fields
    const fields = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
    const clean = (s) => (s || '').replace(/^"|"$/g, '').trim();

    const [id, item_group_id, title, description, link, image_link, priceField, availability] =
      fields.map(clean);

    if (!id) continue;

    // Price is stored as "24.99 USD" — extract the numeric part
    const price = priceField ? priceField.split(' ')[0] : '0.00';

    catalogMap.set(id, { id, item_group_id, title, description, link, image_link, price, availability });
  }

  console.log(`[catalog] Loaded ${catalogMap.size} product variants from product_catalog.csv`);
  return catalogMap;
}

export function getCatalogMap() {
  if (!catalogMap) loadCatalog();
  return catalogMap;
}

export function getCatalogArray() {
  return Array.from(getCatalogMap().values());
}
