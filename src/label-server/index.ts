import type { At, ComAtprotoLabelDefs } from '@atcute/client/lexicons';
import type { ServerWebSocket } from 'bun';
import type { Hono, HonoRequest } from 'hono';
import type { WSContext } from 'hono/ws';
import type { LabelDatabase } from '..';
import { labels, type LabelsTable } from './db/schema';

import { createBunWebSocket } from 'hono/bun';
import { encode as cborEncode, toBytes } from '@atcute/cbor';
import { concat as ui8Concat } from 'uint8arrays';
import { gt } from 'drizzle-orm';

export class LablerServer {
  constructor(
    private app: Hono,
    private db: LabelDatabase,
  ) {
    const { upgradeWebSocket, websocket } =
      createBunWebSocket<ServerWebSocket>();
    const that = this;
    app.get(
      '/xrpc/com.atproto.label.subscribeLabels',
      upgradeWebSocket((c) => {
        return {
          onMessage(event, ws) {
            console.log(`Message from client: ${event.data}`);
            that.subscribeLabelsHandler(ws, c.req);
            ws.send('Hello from server!');
          },
          onClose: () => {
            console.log('Connection closed');
          },
        };
      }),
    );
  }

  /**
   * Handler for [com.atproto.label.subscribeLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/subscribeLabels.json).
   */
  subscribeLabelsHandler = async (ws: WSContext, req: HonoRequest) => {
    const cursor = Number.parseInt(req.query('cursor') ?? 'NaN', 10);

    if (!Number.isNaN(cursor)) {
      const latest = this.db
        .select({
          id: labels.id,
        })
        .from(labels)
        .get() as { id: number };
      if (cursor > (latest.id ?? 0)) {
        const errorBytes = frameToBytes('error', {
          error: 'FutureCursor',
          message: 'Cursor is in the future',
        });
        ws.send(errorBytes);
        ws.close();
      }

      const unprocessedLabels = await this.db
        .select()
        .from(labels)
        .where(gt(labels.id, cursor));

      try {
        for (const row of unprocessedLabels) {
          const { id: seq, ...label } = row as SavedLabel;
          const bytes = frameToBytes(
            'message',
            { seq, labels: [formatLabel(label)] },
            '#labels',
          );
          ws.send(bytes);
        }
      } catch (e) {
        console.error(e);
        const errorBytes = frameToBytes('error', {
          error: 'InternalServerError',
          message: 'An unknown error occurred',
        });
        ws.send(errorBytes);
        ws.close();
      }
    }

    this.addSubscription('com.atproto.label.subscribeLabels', ws);

    ws.on('close', () => {
      this.removeSubscription('com.atproto.label.subscribeLabels', ws);
    });
  };
}

export function frameToBytes(type: 'error', body: unknown): Uint8Array;
export function frameToBytes(
  type: 'message',
  body: unknown,
  t: string,
): Uint8Array;
export function frameToBytes(
  type: 'error' | 'message',
  body: unknown,
  t?: string,
): Uint8Array {
  const header = type === 'error' ? { op: -1 } : { op: 1, t };
  return ui8Concat([cborEncode(header), cborEncode(body)]);
}

type NullishKeys<T> = {
  [K in keyof T]: null extends T[K] ? K : undefined extends T[K] ? K : never;
}[keyof T];
type NonNullishKeys<T> = Exclude<keyof T, NullishKeys<T>>;
export type NonNullishPartial<T> = {
  [K in NullishKeys<T>]+?: Exclude<T[K], null | undefined>;
} & { [K in NonNullishKeys<T>]-?: T[K] };

export function excludeNullish<T extends Record<PropertyKey, unknown>>(
  obj: T,
): NonNullishPartial<T> {
  return Object.entries(obj).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      if (value != null) {
        acc[key] = value;
      }
      return acc;
    },
    {},
  ) as never;
}

export type UnsignedLabel = Omit<ComAtprotoLabelDefs.Label, 'sig'>;
export type SignedLabel = UnsignedLabel & { sig: Uint8Array };
export type FormattedLabel = UnsignedLabel & { sig?: At.Bytes };
export type SavedLabel = UnsignedLabel & { sig: ArrayBuffer; id: number };

const LABEL_VERSION = 1;

export function formatLabel(
  label: UnsignedLabel & { sig?: ArrayBuffer | Uint8Array | At.Bytes },
): FormattedLabel {
  const sig =
    label.sig instanceof ArrayBuffer
      ? toBytes(new Uint8Array(label.sig))
      : label.sig instanceof Uint8Array
        ? toBytes(label.sig)
        : label.sig;
  if (!sig || !('$bytes' in sig)) {
    throw new Error(
      `Expected sig to be an object with base64 $bytes, got ${sig}`,
    );
  }
  return excludeNullish({
    ...label,
    ver: LABEL_VERSION,
    neg: !!label.neg,
    sig,
  });
}
