import { blob, int, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const labels = sqliteTable("labels", {
  id: int().primaryKey({ autoIncrement: true }),
  src: text().notNull(),
  uri: text().notNull(),
  cid: text(),
  val: text().notNull(),
  neg: int({ mode: 'boolean' }).default(false),
  cts: text().notNull(),
  exp: text(),
  sig: blob()
});

export type LabelsTable = typeof labels;

export type Label = typeof labels.$inferSelect;

export type LabelInsert = typeof labels.$inferInsert;
