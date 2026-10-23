import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createStaticHandler } from './static-delivery.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const directory = resolve(option('--dir', 'dist'));
const port = Number(option('--port', '4173'));
const host = option('--host', '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const handler = await createStaticHandler({ directory, base: option('--base', undefined) });
const server = createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
server.listen(port, host, () => console.log(`寰游 PC · http://${host}:${port}/ · ${directory}`));
