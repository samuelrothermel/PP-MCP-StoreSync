import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const PAYPAL_JWKS_SANDBOX = 'https://api.sandbox.paypal.com/v1/oauth2/certs';
const PAYPAL_JWKS_PRODUCTION = 'https://api.paypal.com/v1/oauth2/certs';

const jwksUri =
  process.env.PAYPAL_ENVIRONMENT === 'PRODUCTION'
    ? PAYPAL_JWKS_PRODUCTION
    : PAYPAL_JWKS_SANDBOX;

const client = jwksClient({
  jwksUri,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 minutes
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Verifies the PayPal-issued Bearer JWT on incoming cart/checkout requests.
 * In strict mode (PAYPAL_JWT_STRICT=true), rejected tokens return 401.
 * Otherwise, invalid tokens are logged and the request continues — useful
 * during early sandbox testing before PayPal has fully provisioned your merchant.
 */
export function verifyPayPalToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (process.env.PAYPAL_JWT_STRICT === 'true') {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    console.warn('[auth] No Bearer token — proceeding in non-strict mode');
    return next();
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) {
      if (process.env.PAYPAL_JWT_STRICT === 'true') {
        return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
      }
      console.warn('[auth] JWT verification failed (non-strict):', err.message);
      return next();
    }
    req.paypalToken = decoded;
    next();
  });
}
