/**
 * A tiny deterministic "shop" with ONE side effect (POST /order) and an oracle (GET /orders), used to prove that a
 * resumed mission does not repeat a submit (#226). Run directly (`tsx tests/helpers/fixture_shop.ts`) it prints
 * `SHOP_PORT=<n>` and serves until killed (the real-app driver uses it that way).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureShop { port: number; base: string; orders(): number; close(): Promise<void> }

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif">${body}</body></html>`;

export async function startFixtureShop(port = 0): Promise<FixtureShop> {
  let orders = 0;
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && url === '/order') {
      orders++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, orders }));
      return;
    }
    if (url === '/orders') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ orders })); return; }
    res.setHeader('content-type', 'text/html');
    if (url === '/shop') {
      res.end(page('Fixture shop', `<h1>Fixture shop</h1><p>Widget Pro - $19.99</p>
<button id="place" onclick="fetch('/order',{method:'POST'}).then(()=>{location.href='/confirmation'})">Place order</button>`));
    } else if (url === '/confirmation') {
      res.end(page('Order confirmed', `<h1>Order confirmed</h1><p>Thank you. Your order for Widget Pro was received.</p><a href="/shop">Back to the shop</a>`));
    } else {
      res.statusCode = 404;
      res.end(page('Not found', '<h1>Not found</h1>'));
    }
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const p = (server.address() as AddressInfo).port;
  return {
    port: p,
    base: `http://127.0.0.1:${p}`,
    orders: () => orders,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); })
  };
}

if (process.argv[1] && /fixture_shop\.[tj]s$/.test(process.argv[1])) {
  startFixtureShop(Number(process.env.SHOP_PORT || 0)).then(s => console.log(`SHOP_PORT=${s.port}`));
}
