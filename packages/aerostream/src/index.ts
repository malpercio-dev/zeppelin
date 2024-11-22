import { Aerostream } from './aerostream';

const jetstream = new Aerostream({
  //   wantedDids: ['did:web:example.com'], // omit to receive events from all dids
});

jetstream.register('app.bsky.feed.like', (topic, data) => {
  console.log(topic, data);
});

jetstream.register('app.bsky.feed.post', (topic, data) => {
  console.log(topic, data);
});

jetstream.start();

export default Aerostream;
