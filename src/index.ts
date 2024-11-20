import 'dotenv/config';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono';

// biome-ignore lint/style/noNonNullAssertion: <explanation>
const sqlite = new Database(process.env.DB_FILE_NAME!);
const db = drizzle({ client: sqlite });

export type LabelDatabase = typeof db;

const app = new Hono();

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

export default app;
