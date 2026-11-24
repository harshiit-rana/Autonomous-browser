/**
 * Three independent shops for the swarm price-compare e2e (#227): three HTTP servers, so three origins (the swarm's
 * politeness rules are per origin, exactly as with three real shops). Each page quotes a different price for the same
 * product and keeps a heartbeat (`/beat` every 900 ms, slower than the swarm's 500 ms network-quiet window so pages can still settle) while it is open, so the test can read from the SHOPS' side
 * how long each page was open and whether the three were open at the same time.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ShopSpec {
  key: string;
  name: string;
  priceText: string;
  /** The sentence the page shows; a worker must quote it verbatim. */
  offerLine: string;
}

export interface ShopHandle extends ShopSpec {
  origin: string;
  productUrl: string;
  /** Times (ms since epoch) at which a page of this shop reported it was open. */
  beats(): number[];
  /** Times at which the product page was requested. */
  hits(): number[];
  stop(): Promise<void>;
}

export const PRODUCT = 'Aegis Widget X';

export const SHOPS: ShopSpec[] = [
  { key: 'alpha', name: 'Shop Alpha', priceText: '$129.00', offerLine: `${PRODUCT}: $129.00 including tax` },
  { key: 'beta', name: 'Shop Beta', priceText: '$119.50', offerLine: `${PRODUCT}: $119.50 including tax` },
  { key: 'gamma', name: 'Shop Gamma', priceText: '$134.99', offerLine: `${PRODUCT}: $134.99 including tax` }
];

export function pageHtml(shop: ShopSpec): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${shop.name} - ${PRODUCT}</title></head>
<body>
<h1>${shop.name}</h1>
<p>Welcome to ${shop.name}. Free returns within 30 days.</p>
<p class="offer">${shop.offerLine}</p>
<p>Shipping from $4.00. In stock.</p>
<script>fetch('/beat').catch(function(){}); setInterval(function(){ fetch('/beat').catch(function(){}); }, 900);</script>
</body></html>`;
}

export async function startShop(spec: ShopSpec): Promise<ShopHandle> {
  const beats: number[] = [];
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/beat') {
      beats.push(Date.now());
      res.writeHead(204).end();
    } else if (path === '/product') {
      hits.push(Date.now());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(pageHtml(spec));
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...spec,
    origin,
    productUrl: `${origin}/product`,
    beats: () => [...beats],
    hits: () => [...hits],
    stop: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}
