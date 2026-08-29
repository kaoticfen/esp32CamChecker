#!/usr/bin/env node
// Container healthcheck. Follows the same TLS/port logic as config.ts.
const tls = Boolean(process.env.TLS_CERT_FILE);
const port = process.env.HUB_PORT ?? (tls ? '8443' : '8080');

// The hub's certificate is issued by a local CA that this container does not
// trust, and a loopback probe gains nothing from verifying it.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

try {
  const response = await fetch(`${tls ? 'https' : 'http'}://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
