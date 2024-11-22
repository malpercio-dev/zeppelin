import type {
  AccountEvent,
  Collection,
  CollectionOrWildcard,
  CommitEvent,
  IdentityEvent,
  ResolveLexiconWildcard,
} from '@skyware/jetstream';

import { CommitType, EventType } from '@skyware/jetstream';
import PubSub from 'pubsub-js';

export interface AerostreamOptions<
  WantedCollections extends Collection = Collection,
> {
  endpoint?: string;
  wantedCollections?: Array<WantedCollections>;
  wantedDids?: Array<string>;
}

export class Aerostream<
  WantedCollections extends CollectionOrWildcard = CollectionOrWildcard,
  ResolvedCollections extends
    Collection = ResolveLexiconWildcard<WantedCollections>,
> {
  collectionWorkers: Map<Collection, Array<Worker>> = new Map();
  url: URL;

  cursor?: number;
  checkpointInterval?: Timer;
  ws?: WebSocket;

  constructor(private options?: AerostreamOptions) {
    this.url = new URL(
      this.options?.endpoint ??
        'wss://jetstream1.us-east.bsky.network/subscribe',
    );
  }

  register<T extends Collection>(
    collection: T,
    handler: (topic: string, data: CommitEvent<T>) => void,
  ): void {
    if (this.ws) {
      throw new Error('Must register before starting');
    }
    PubSub.subscribe(collection, handler);
  }

  async start() {
    const cursorFile = Bun.file('cursor.txt');
    if (await cursorFile.exists()) {
      this.cursor = Number.parseInt(await cursorFile.text());
    } else {
      cursorFile.writer().write('');
    }
    if (this.cursor) console.log(`Initiate jetstream at cursor ${this.cursor}`);

    for (const collection of this.options?.wantedCollections ?? []) {
      this.url.searchParams.append('wantedCollections', collection);
    }
    for (const did of this.options?.wantedDids ?? []) {
      this.url.searchParams.append('wantedDids', did);
    }

    this.ws = new WebSocket(this.createUrl());

    this.ws.onopen = () => {
      this.checkpointInterval = setInterval(() => {
        if (!this.cursor) return;
        Bun.file('cursor.txt').writer().write(this.cursor.toString());
      }, 5);
    };
    this.ws.onclose = () => {
      clearInterval(this.checkpointInterval);
    };
    // this.ws.onerror = ({ error }) => this.emit('error', error, this.cursor);

    this.ws.onmessage = (data) => {
      try {
        const event = JSON.parse(data.data) as
          | CommitEvent<ResolvedCollections>
          | AccountEvent
          | IdentityEvent;
        if (event.time_us > (this.cursor ?? 0)) this.cursor = event.time_us;
        switch (event.kind) {
          case EventType.Commit: {
            if (
              !event.commit?.collection ||
              !event.commit.rkey ||
              !event.commit.rev
            ) {
              return;
            }
            if (
              event.commit.operation === CommitType.Create &&
              !event.commit.record
            ) {
              return;
            }

            PubSub.publish(event.commit.collection, event);
            break;
          }
          case EventType.Account:
            if (!event.account?.did) return;
            // this.emit('account', event);
            break;
          case EventType.Identity:
            if (!event.identity?.did) return;
            // this.emit('identity', event);
            break;
        }
      } catch (e) {
        // this.emit(
        //   'error',
        //   e instanceof Error ? e : new Error(e as never),
        //   this.cursor,
        // );
      }
    };
  }

  private createUrl() {
    if (this.cursor)
      this.url.searchParams.set('cursor', this.cursor.toString());
    return this.url.toString();
  }
}
