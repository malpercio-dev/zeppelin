import 'dotenv/config';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import { LabelerServer } from './label-server';

// biome-ignore lint/style/noNonNullAssertion: <explanation>
const sqlite = new Database(process.env.DB_FILE_NAME!);

// enable WAL mode
sqlite.exec("PRAGMA journal_mode = WAL;");
const db = drizzle({ client: sqlite });

export type LabelDatabase = typeof db;

const app = new Hono();

const labelerServer = new LabelerServer(
  db,
  `did:${process.env.DID}`,
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  process.env.SIGNING_KEY!,
);

app.route('/labels', labelerServer.app);

export default app;
