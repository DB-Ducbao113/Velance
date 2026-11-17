// Only started by recovery.mjs with a disposable root and database.
import { once } from 'node:events';
import { createOpsServer } from '../../server.mjs';

const { root, dbPath } = JSON.parse(process.argv[2]);
const server = await createOpsServer({ root, dbPath });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.send({ type: 'ready', port: server.address().port });
