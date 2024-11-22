import 'dotenv/config';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import { LabelerServer } from 'label-server';
import { Aerostream } from 'aerostream';

// biome-ignore lint/style/noNonNullAssertion: <explanation>
const sqlite = new Database(process.env.DB_FILE_NAME!);

// enable WAL mode
sqlite.exec("PRAGMA journal_mode = WAL;");
const db = drizzle({ client: sqlite });

const app = new Hono();

const labelerServer = new LabelerServer(
  db,
  `did:${process.env.DID}`,
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  process.env.SIGNING_KEY!,
);
const aerostream = new Aerostream({
  wantedDids: [process.env.DID]
})

app.route('/labels', labelerServer.app);

export default app;
