import '@atcute/ozone/lexicons';
import type {
  At,
  ComAtprotoLabelQueryLabels,
  ToolsOzoneModerationEmitEvent,
} from '@atcute/client/lexicons';
import type { DidDocument } from '@atcute/client/utils/did';
import type { ServerWebSocket } from 'bun';
import type { Context, HonoRequest } from 'hono';
import type { WSContext } from 'hono/ws';
import type { StatusCode } from 'hono/utils/http-status';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { LabelInsert } from './db/schema';
import type { SavedLabel, SignedLabel, UnsignedLabel } from '@skyware/labeler';

import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { encode as cborEncode } from '@atcute/cbor';
import { concat as ui8Concat } from 'uint8arrays';
import * as ui8 from 'uint8arrays';
import { and, gt, inArray, like, or } from 'drizzle-orm';
import { XRPCError } from '@atcute/client';
import { p256 } from '@noble/curves/p256';
import { secp256k1 as k256 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { labels } from './db/schema';
import { formatLabel, labelIsSigned, signLabel } from '@skyware/labeler';

const INVALID_SIGNING_KEY_ERROR = "Please provide a signing key";

export class LabelerServer {
  /** The Hono app for mounting the LabelerServer */
  public app: Hono;

  /** Open WebSocket connections, mapped by request NSID. */
  private connections = new Map<string, Set<WSContext>>();

  /** A function that returns whether a DID is authorized to create labels. */
  private auth: (did: string) => boolean | Promise<boolean>;

  /** The signing key used for the labeler. */
  #signingKey: Uint8Array;

  constructor(
    private db: BunSQLiteDatabase,
    private did: At.DID,
    signingKey: string,
  ) {
    this.auth = (did) => did === this.did;
    this.app = new Hono();

    try {
      if (signingKey.startsWith('did:key:')) throw 0;
      this.#signingKey = parsePrivateKey(signingKey);
      if (this.#signingKey.byteLength !== 32) throw 0;
    } catch {
      throw new Error(INVALID_SIGNING_KEY_ERROR);
    }

    const { upgradeWebSocket } = createBunWebSocket<ServerWebSocket>();

    const that = this;

    this.app.get(
      '/xrpc/com.atproto.label.queryLabels',
      this.queryLabelsHandler,
    );
    this.app.post(
      '/xrpc/tools.ozone.moderation.emitEvent',
      this.emitEventHandler,
    );

    this.app.get(
      '/xrpc/com.atproto.label.subscribeLabels',
      upgradeWebSocket((c) => {
        return {
          onMessage(event, ws) {
            console.log(`Message from client: ${event.data}`);
            that.subscribeLabelsHandler(ws, c.req);
            ws.send('Hello from server!');
          },
          onClose: (_, ws: WSContext) => {
            this.removeSubscription('com.atproto.label.subscribeLabels', ws);
            console.log('Connection closed');
          },
        };
      }),
    );

    this.app.get('/xrpc/*', this.unknownMethodHandler);

    this.app.onError(this.errorHandler);
  }

  /**
   * Handler for [tools.ozone.moderation.emitEvent](https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/emitEvent.json).
   */
  emitEventHandler = async (c: Context) => {
    const actorDid = await this.parseAuthHeaderDid(c.req);
    const authed = await this.auth(actorDid);
    if (!authed) {
      throw new XRPCError(401, {
        kind: 'AuthRequired',
        description: 'Unauthorized',
      });
    }

    const {
      event,
      subject,
      subjectBlobCids = [],
      createdBy,
    } = await c.req.json();
    if (!event || !subject || !createdBy) {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Missing required field(s)',
      });
    }

    if (event.$type !== 'tools.ozone.moderation.defs#modEventLabel') {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Unsupported event type',
      });
    }

    if (!event.createLabelVals?.length && !event.negateLabelVals?.length) {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Must provide at least one label value',
      });
    }

    const uri =
      subject.$type === 'com.atproto.admin.defs#repoRef'
        ? subject.did
        : subject.$type === 'com.atproto.repo.strongRef'
          ? subject.uri
          : null;
    const cid =
      subject.$type === 'com.atproto.repo.strongRef' ? subject.cid : undefined;

    if (!uri) {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Invalid subject',
      });
    }

    const labels = this.createLabels(
      { uri, cid },
      {
        create: event.createLabelVals,
        negate: event.negateLabelVals,
      },
    );

    if (!labels.length || !labels[0]?.id) {
      throw new Error(
        `No labels were created\nEvent:\n${JSON.stringify(event, null, 2)}`,
      );
    }

    return c.json({
      id: labels[0].id,
      event,
      subject,
      subjectBlobCids,
      createdBy,
      createdAt: new Date().toISOString(),
    } satisfies ToolsOzoneModerationEmitEvent.Output);
  };

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
  };

  /**
   * Handler for [com.atproto.label.queryLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/queryLabels.json).
   */
  queryLabelsHandler = async (c: Context) => {
    let uriPatterns: Array<string>;
    const queryUriPatterns = c.req.query('uriPatterns');
    if (!queryUriPatterns) {
      uriPatterns = [];
    } else if (typeof queryUriPatterns === 'string') {
      uriPatterns = [queryUriPatterns];
    } else {
      uriPatterns = queryUriPatterns || [];
    }

    let sources: Array<string>;
    const querySources = c.req.query('sources');
    if (!querySources) {
      sources = [];
    } else if (typeof querySources === 'string') {
      sources = [querySources];
    } else {
      sources = querySources || [];
    }

    const cursor = Number.parseInt(`${c.req.query('cursor') || 0}`, 10);
    if (cursor !== undefined && Number.isNaN(cursor)) {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Cursor must be an integer',
      });
    }

    const limit = Number.parseInt(`${c.req.query('limit') || 50}`, 10);
    if (Number.isNaN(limit) || limit < 1 || limit > 250) {
      throw new XRPCError(400, {
        kind: 'InvalidRequest',
        description: 'Limit must be an integer between 1 and 250',
      });
    }

    const patterns = uriPatterns.includes('*')
      ? []
      : uriPatterns.map((pattern) => {
          const ptn = pattern.replaceAll(/%/g, '').replaceAll(/_/g, '\\_');

          const starIndex = pattern.indexOf('*');
          if (starIndex === -1) return pattern;

          if (starIndex !== pattern.length - 1) {
            throw new XRPCError(400, {
              kind: 'InvalidRequest',
              description:
                'Only trailing wildcards are supported in uriPatterns',
            });
          }
          return `${ptn.slice(0, -1)}%`;
        });

    const lbs = this.db
      .select()
      .from(labels)
      .where(
        and(
          patterns.length
            ? or(...patterns.map((p) => like(labels.uri, p)))
            : undefined,
          sources.length ? and(inArray(labels.src, sources)) : undefined,
          cursor ? and(gt(labels.id, cursor)) : undefined,
        ),
      )
      .orderBy(labels.id)
      .limit(limit);

    const rows = (await lbs) as Array<SavedLabel>;
    const formatLabels = rows.map(formatLabel);

    const nextCursor = rows[rows.length - 1]?.id?.toString(10) || '0';

    return c.json({
      cursor: nextCursor,
      labels: formatLabels,
    } satisfies ComAtprotoLabelQueryLabels.Output);
  };

  /**
   * Catch-all handler for unknown XRPC methods.
   */
  unknownMethodHandler = async (c: Context) => {
    c.status(501);
    return c.json({
      error: 'MethodNotImplemented',
      message: 'Method Not Implemented',
    });
  };

  /**
   * Default error handler.
   */
  errorHandler = async (err: unknown, c: Context) => {
    if (err instanceof XRPCError) {
      c.status(err.status as StatusCode);
      return c.json({ error: err.kind, message: err.description });
    }
    console.error(err);
    c.status(500);
    return c.json({
      error: 'InternalServerError',
      message: 'An unknown error occurred',
    });
  };

  /**
   * Create and insert labels into the database, emitting them to subscribers.
   * @param subject The subject of the labels.
   * @param labels The labels to create.
   * @returns The created labels.
   */
  createLabels(
    subject: { uri: string; cid?: string | undefined },
    labels: { create?: Array<string>; negate?: Array<string> },
  ): Array<SavedLabel> {
    const { uri, cid } = subject;
    const { create, negate } = labels;

    const createdLabels: Array<SavedLabel> = [];
    const cts = new Date().toISOString();
    const src = this.did;
    if (create) {
      for (const val of create) {
        const created = this.createLabel({ uri, cid, val, cts, src });
        createdLabels.push(created);
      }
    }
    if (negate) {
      for (const val of negate) {
        const negated = this.createLabel({
          uri,
          cid,
          val,
          cts,
          src,
          neg: true,
        });
        createdLabels.push(negated);
      }
    }
    return createdLabels;
  }

  /**
   * Create and insert a label into the database, emitting it to subscribers.
   * @param label The label to create.
   * @returns The created label.
   */
  createLabel(label: LabelInsert): SavedLabel {
    return this.saveLabel(
      excludeNullish({
        ...label,
        src: (label.src ?? this.did) as At.DID,
        cts: label.cts ?? new Date().toISOString(),
      }),
    );
  }

  /**
   * Add a WebSocket connection to the list of subscribers for a given lexicon.
   * @param nsid The NSID of the lexicon to subscribe to.
   * @param ws The WebSocket connection to add.
   */
  private addSubscription(nsid: string, ws: WSContext) {
    const subs = this.connections.get(nsid) ?? new Set();
    subs.add(ws);
    this.connections.set(nsid, subs);
  }

  /**
   * Remove a WebSocket connection from the list of subscribers for a given lexicon.
   * @param nsid The NSID of the lexicon to unsubscribe from.
   * @param ws The WebSocket connection to remove.
   */
  private removeSubscription(nsid: string, ws: WSContext) {
    const subs = this.connections.get(nsid);
    if (subs) {
      subs.delete(ws);
      if (!subs.size) this.connections.delete(nsid);
    }
  }

  /**
   * Parse a user DID from an Authorization header JWT.
   * @param req The Express request object.
   */
  private async parseAuthHeaderDid(req: HonoRequest): Promise<string> {
    const authHeader = req.header('authorization');
    if (!authHeader) {
      throw new XRPCError(401, {
        kind: 'AuthRequired',
        description: 'Authorization header is required',
      });
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new XRPCError(400, {
        kind: 'MissingJwt',
        description: 'Missing or invalid bearer token',
      });
    }

    const nsid = (req.url || '')
      .split('?')[0]
      .replace('/xrpc/', '')
      .replace(/\/$/, '');

    const payload = await verifyJwt(token, this.did, nsid);

    return payload.iss;
  }

  /**
   * Insert a label into the database, emitting it to subscribers.
   * @param label The label to insert.
   * @returns The inserted label.
   */
  private saveLabel(label: UnsignedLabel): SavedLabel {
    const signed = labelIsSigned(label)
      ? label
      : signLabel(label, this.#signingKey);

    const { src, uri, cid, val, neg, cts, exp, sig } = signed;

    const result = this.db
      .insert(labels)
      .values({
        src,
        uri,
        cid,
        val,
        neg,
        cts,
        exp,
        sig,
      })
      .returning()
      .get();
    if (!result) throw new Error('Failed to insert label');

    const id = Number(result.id);

    this.emitLabel(id, signed);
    return { id, src, uri, cid, val, neg, cts, exp, sig: sig.buffer as ArrayBuffer };
  }

  /**
   * Emit a label to all subscribers.
   * @param seq The label's id.
   * @param label The label to emit.
   */
  private emitLabel(seq: number, label: SignedLabel) {
    const bytes = frameToBytes(
      'message',
      { seq, labels: [formatLabel(label)] },
      '#labels',
    );
    for (const ws of this.connections.get(
      'com.atproto.label.subscribeLabels',
    ) ?? []) {
      ws.send(bytes);
    }
  }
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

/*** The below is from @skyware/labeler    ***/
/*** only needed for one function, verifyJwt */

const P256_DID_PREFIX = new Uint8Array([0x80, 0x24]);
const SECP256K1_DID_PREFIX = new Uint8Array([0xe7, 0x01]);
// should equal P256_DID_PREFIX.length and SECP256K1_DID_PREFIX.length
const DID_PREFIX_LENGTH = 2;

const BASE58_MULTIBASE_PREFIX = 'z';
const DID_KEY_PREFIX = 'did:key:';

export const P256_JWT_ALG = 'ES256';
export const SECP256K1_JWT_ALG = 'ES256K';

export function k256Sign(privateKey: Uint8Array, msg: Uint8Array): Uint8Array {
  const msgHash = sha256(msg);
  const sig = k256.sign(msgHash, privateKey, { lowS: true });
  return sig.toCompactRawBytes();
}

/**
 * Verifies a JWT.
 * @param jwtStr The JWT to verify.
 * @param ownDid The DID of the service that is receiving the request.
 * @param lxm The lexicon method that is being called.
 * @returns The payload of the JWT.
 */
export async function verifyJwt(
  jwtStr: string,
  ownDid: string | null,
  lxm: string | null,
): Promise<{
  iss: string;
  aud: string;
  exp: number;
  lxm?: string;
  jti?: string;
}> {
  const parts = jwtStr.split('.');
  if (parts.length !== 3) {
    throw new XRPCError(401, {
      kind: 'BadJwt',
      description: 'Poorly formatted JWT',
    });
  }
  const payload = parsePayload(parts[1]);
  const sig = parts[2];

  if (Date.now() / 1000 > payload.exp) {
    throw new XRPCError(401, {
      kind: 'JwtExpired',
      description: 'JWT expired',
    });
  }
  if (ownDid !== null && payload.aud !== ownDid) {
    throw new XRPCError(401, {
      kind: 'BadJwtAudience',
      description: 'JWT audience does not match service DID',
    });
  }
  if (lxm !== null && payload.lxm !== lxm) {
    throw new XRPCError(401, {
      kind: 'BadJwtLexiconMethod',
      description:
        payload.lxm !== undefined
          ? `Bad JWT lexicon method ("lxm"). Must match: ${lxm}`
          : `Missing JWT lexicon method ("lxm"). Must match: ${lxm}`,
    });
  }

  const msgBytes = ui8.fromString(parts.slice(0, 2).join('.'), 'utf8');
  const sigBytes = ui8.fromString(sig, 'base64url');

  const signingKey = await resolveDidToSigningKey(payload.iss, false).catch(
    (e) => {
      console.error(e);
      throw new XRPCError(500, {
        kind: 'InternalError',
        description: 'Could not resolve DID',
      });
    },
  );

  let validSig: boolean;
  try {
    validSig = verifySignatureWithKey(signingKey, msgBytes, sigBytes);
  } catch (err) {
    throw new XRPCError(401, {
      kind: 'BadJwtSignature',
      description: 'Could not verify JWT signature',
    });
  }

  if (!validSig) {
    // get fresh signing key in case it failed due to a recent rotation
    const freshSigningKey = await resolveDidToSigningKey(payload.iss, true);
    try {
      validSig =
        freshSigningKey !== signingKey
          ? verifySignatureWithKey(freshSigningKey, msgBytes, sigBytes)
          : false;
    } catch (err) {
      throw new XRPCError(401, {
        kind: 'BadJwtSignature',
        description: 'Could not verify JWT signature',
      });
    }
  }

  if (!validSig) {
    throw new XRPCError(401, {
      kind: 'BadJwtSignature',
      description: 'JWT signature does not match JWT issuer',
    });
  }

  return payload;
}

/**
 * Parses a JWT payload.
 * @param b64 The JWT payload to parse.
 */
const parsePayload = (
  b64: string,
): { iss: string; aud: string; exp: number; lxm?: string; nonce?: string } => {
  const payload = JSON.parse(
    ui8.toString(ui8.fromString(b64, 'base64url'), 'utf8'),
  );
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.iss !== 'string' ||
    typeof payload.aud !== 'string' ||
    typeof payload.exp !== 'number' ||
    (payload.lxm && typeof payload.lxm !== 'string') ||
    (payload.nonce && typeof payload.nonce !== 'string')
  ) {
    throw new XRPCError(401, {
      kind: 'BadJwt',
      description: 'Poorly formatted JWT',
    });
  }
  return payload;
};

const didToSigningKeyCache = new Map<
  string,
  { key: string; expires: number }
>();

/**
 * Resolves the atproto signing key for a DID.
 * @param did The DID to resolve.
 * @param forceRefresh Whether to skip the cache and always resolve the DID.
 * @returns The resolved signing key.
 */
export async function resolveDidToSigningKey(
  did: string,
  forceRefresh?: boolean,
): Promise<string> {
  if (!forceRefresh) {
    const cached = didToSigningKeyCache.get(did);
    if (cached) {
      const now = Date.now();
      if (now < cached.expires) {
        return cached.key;
      }
      didToSigningKeyCache.delete(did);
    }
  }

  const [, didMethod, ...didValueParts] = did.split(':');

  let didKey: string | undefined = undefined;
  if (didMethod === 'plc') {
    const res = await fetch(`https:/plc.directory/${encodeURIComponent(did)}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Could not resolve DID: ${did}`);

    didKey = parseKeyFromDidDocument((await res.json()) as never, did);
  } else if (didMethod === 'web') {
    if (!didValueParts.length) throw new Error(`Poorly formatted DID: ${did}`);
    if (didValueParts.length > 1)
      throw new Error(`Unsupported did:web paths: ${did}`);
    const didValue = didValueParts[0];

    const res = await fetch(`https://${didValue}/.well-known/did.json`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Could not resolve DID: ${did}`);

    didKey = parseKeyFromDidDocument((await res.json()) as never, did);
  }

  if (!didKey) throw new Error(`Could not resolve DID: ${did}`);
  didToSigningKeyCache.set(did, {
    key: didKey,
    expires: Date.now() + 60 * 60 * 1000,
  });
  return didKey;
}

/**
 * Parses a DID document and extracts the atproto signing key.
 * @param doc The DID document to parse.
 * @param did The DID the document is for.
 * @returns The atproto signing key.
 */
const parseKeyFromDidDocument = (doc: DidDocument, did: string): string => {
  if (!Array.isArray(doc?.verificationMethod)) {
    throw new Error(
      `Could not parse signingKey from doc: ${JSON.stringify(doc)}`,
    );
  }
  const key = doc.verificationMethod.find(
    (method) => method?.id === `${did}#atproto` || method?.id === '#atproto',
  );
  if (
    !key ||
    typeof key !== 'object' ||
    !('type' in key) ||
    typeof key.type !== 'string' ||
    !('publicKeyMultibase' in key) ||
    typeof key.publicKeyMultibase !== 'string'
  ) {
    throw new Error(`Could not resolve DID: ${did}`);
  }

  const keyBytes = multibaseToBytes(key.publicKeyMultibase);
  let didKey: string | undefined = undefined;
  if (key.type === 'EcdsaSecp256r1VerificationKey2019') {
    didKey = formatDidKey(P256_JWT_ALG, keyBytes);
  } else if (key.type === 'EcdsaSecp256k1VerificationKey2019') {
    didKey = formatDidKey(SECP256K1_JWT_ALG, keyBytes);
  } else if (key.type === 'Multikey') {
    const parsed = parseDidMultikey(`did:key:${key.publicKeyMultibase}`);
    didKey = formatDidKey(parsed.jwtAlg, parsed.keyBytes);
  }
  if (!didKey)
    throw new Error(
      `Could not parse signingKey from doc: ${JSON.stringify(doc)}`,
    );
  return didKey;
};

/**
 * Parses a multibase encoded string to a Uint8Array.
 * @param mb The multibase encoded string.
 */
const multibaseToBytes = (mb: string): Uint8Array => {
  const base = mb[0];
  const key = mb.slice(1);
  switch (base) {
    case 'f':
      return ui8.fromString(key, 'base16');
    case 'F':
      return ui8.fromString(key, 'base16upper');
    case 'b':
      return ui8.fromString(key, 'base32');
    case 'B':
      return ui8.fromString(key, 'base32upper');
    case 'z':
      return ui8.fromString(key, 'base58btc');
    case 'm':
      return ui8.fromString(key, 'base64');
    case 'u':
      return ui8.fromString(key, 'base64url');
    case 'U':
      return ui8.fromString(key, 'base64urlpad');
    default:
      throw new Error(`Unsupported multibase: :${mb}`);
  }
};

/**
 * Formats a pubkey in did:key format.
 * @param jwtAlg The JWT algorithm used by the signing key.
 * @param keyBytes The bytes of the pubkey.
 */
export const formatDidKey = (
  jwtAlg: typeof P256_JWT_ALG | typeof SECP256K1_JWT_ALG,
  keyBytes: Uint8Array,
): string => DID_KEY_PREFIX + formatMultikey(jwtAlg, keyBytes);

/**
 * Formats a signing key as [base58 multibase](https://github.com/multiformats/multibase).
 * @param jwtAlg The JWT algorithm used by the signing key.
 * @param keyBytes The bytes of the signing key.
 */
const formatMultikey = (
  jwtAlg: typeof P256_JWT_ALG | typeof SECP256K1_JWT_ALG,
  keyBytes: Uint8Array,
): string => {
  const curve = jwtAlg === P256_JWT_ALG ? 'p256' : 'k256';
  let prefixedBytes: Uint8Array;
  if (jwtAlg === P256_JWT_ALG) {
    prefixedBytes = ui8.concat([
      P256_DID_PREFIX,
      compressPubkey(curve, keyBytes),
    ]);
  } else if (jwtAlg === SECP256K1_JWT_ALG) {
    prefixedBytes = ui8.concat([
      SECP256K1_DID_PREFIX,
      compressPubkey(curve, keyBytes),
    ]);
  } else {
    throw new Error(`Invalid JWT algorithm: ${jwtAlg}`);
  }
  return BASE58_MULTIBASE_PREFIX + ui8.toString(prefixedBytes, 'base58btc');
};

/**
 * Compresses a pubkey to be used in a did:key.
 * @param curve p256 (secp256r1) or k256 (secp256k1)
 * @param keyBytes The pubkey to compress.
 * @see https://medium.com/asecuritysite-when-bob-met-alice/02-03-or-04-so-what-are-compressed-and-uncompressed-public-keys-6abcb57efeb6
 */
const compressPubkey = (
  curve: 'p256' | 'k256',
  keyBytes: Uint8Array,
): Uint8Array => {
  const ProjectivePoint =
    curve === 'p256' ? p256.ProjectivePoint : k256.ProjectivePoint;
  return ProjectivePoint.fromHex(keyBytes).toRawBytes(true);
};

/**
 * Parses and decompresses the public key and JWT algorithm from multibase.
 * @param didKey The did:key to parse.
 */
const parseDidMultikey = (
  didKey: string,
): {
  jwtAlg: typeof P256_JWT_ALG | typeof SECP256K1_JWT_ALG;
  keyBytes: Uint8Array;
} => {
  const multikey = extractMultikey(didKey);
  const prefixedBytes = extractPrefixedBytes(multikey);

  const keyCurve = hasPrefix(prefixedBytes, P256_DID_PREFIX)
    ? 'p256'
    : hasPrefix(prefixedBytes, SECP256K1_DID_PREFIX)
      ? 'k256'
      : null;
  if (!keyCurve) throw new Error(`Invalid curve for multikey: ${multikey}`);

  const keyBytes = decompressPubkey(
    keyCurve,
    prefixedBytes.subarray(DID_PREFIX_LENGTH),
  );

  return {
    jwtAlg: keyCurve === 'p256' ? P256_JWT_ALG : SECP256K1_JWT_ALG,
    keyBytes,
  };
};

/**
 * Extracts the key component of a did:key.
 * @param did The did:key to extract the key from.
 * @returns A compressed pubkey, without the did:key prefix.
 */
const extractMultikey = (did: string): string => {
  if (!did.startsWith(DID_KEY_PREFIX))
    throw new Error(`Incorrect prefix for did:key: ${did}`);
  return did.slice(DID_KEY_PREFIX.length);
};

/**
 * Removes the base58 multibase prefix from a compressed pubkey.
 * @param multikey The compressed pubkey to remove the prefix from.
 * @returns The pubkey without the multibase base58 prefix.
 */
const extractPrefixedBytes = (multikey: string): Uint8Array => {
  if (!multikey.startsWith(BASE58_MULTIBASE_PREFIX)) {
    throw new Error(`Incorrect prefix for multikey: ${multikey}`);
  }
  return ui8.fromString(
    multikey.slice(BASE58_MULTIBASE_PREFIX.length),
    'base58btc',
  );
};

/**
 * Checks if a bytestring starts with a prefix.
 * @param bytes The bytestring to check.
 * @param prefix The prefix to check for.
 */
const hasPrefix = (bytes: Uint8Array, prefix: Uint8Array): boolean => {
  return ui8.equals(prefix, bytes.subarray(0, prefix.byteLength));
};

/**
 * Decompresses a pubkey.
 * @param curve p256 (secp256r1) or k256 (secp256k1)
 * @param compressed The compressed pubkey to decompress.
 */
const decompressPubkey = (
  curve: 'p256' | 'k256',
  compressed: Uint8Array,
): Uint8Array => {
  if (compressed.length !== 33) {
    throw new Error(`Incorrect compressed pubkey length: ${compressed.length}`);
  }
  const ProjectivePoint =
    curve === 'p256' ? p256.ProjectivePoint : k256.ProjectivePoint;
  return ProjectivePoint.fromHex(compressed).toRawBytes(false);
};

/**
 * Verifies a signature using a signing key in did:key format.
 * @param didKey The signing key to verify the signature with in did:key format.
 * @param msgBytes The message contents to verify.
 * @param sigBytes The signature to verify.
 */
function verifySignatureWithKey(
  didKey: string,
  msgBytes: Uint8Array,
  sigBytes: Uint8Array,
) {
  if (!didKey.startsWith('did:key:'))
    throw new Error(`Incorrect prefix for did:key: ${didKey}`);
  const { jwtAlg } = parseDidMultikey(didKey);
  const curve = jwtAlg === P256_JWT_ALG ? 'p256' : 'k256';
  return verifyDidSig(curve, didKey, msgBytes, sigBytes);
}

/**
 * Verifies a signature using a signing key in did:key format.
 * @param curve p256 (secp256r1) or k256 (secp256k1)
 * @param did The signing key in did:key format.
 * @param data The data to verify.
 * @param sig The signature to verify.
 */
const verifyDidSig = (
  curve: 'p256' | 'k256',
  did: string,
  data: Uint8Array,
  sig: Uint8Array,
): boolean => {
  const prefixedBytes = extractPrefixedBytes(extractMultikey(did));
  const prefix = curve === 'p256' ? P256_DID_PREFIX : SECP256K1_DID_PREFIX;
  if (!hasPrefix(prefixedBytes, prefix)) {
    throw new Error(`Invalid curve for DID: ${did}`);
  }

  const keyBytes = prefixedBytes.slice(prefix.length);
  const msgHash = sha256(data);

  return (curve === 'p256' ? p256 : k256).verify(sig, msgHash, keyBytes, {
    lowS: false,
  });
};

/**
 * Parses a hex- or base64-encoded private key to a Uint8Array.
 * @param privateKey The private key to parse.
 */
export const parsePrivateKey = (privateKey: string): Uint8Array => {
  let keyBytes: Uint8Array | undefined;
  try {
    keyBytes = ui8.fromString(privateKey, 'hex');
    if (keyBytes.byteLength !== 32) throw 0;
  } catch {
    try {
      keyBytes = ui8.fromString(privateKey, 'base64url');
    } catch {}
  } finally {
    if (!keyBytes) {
      // biome-ignore lint/correctness/noUnsafeFinally: <explanation>
      throw new Error(
        'Invalid private key. Must be hex or base64url, and 32 bytes long.',
      );
    }
    // biome-ignore lint/correctness/noUnsafeFinally: <explanation>
    return keyBytes;
  }
};
