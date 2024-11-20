import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/label-server/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    url: process.env.DB_FILE_NAME!,
  },
});
