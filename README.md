# node-event-store-consumer

A Node.js utility for consuming Event Store Competing Consumer subscriptions using Event Store's HTTP API.


## Installation

Available on npm:

```sh
npm install event-store-consumer
```

## Documentation

### `let consumer = new EventStoreConsumer(stream, group, handler, options)`

The `EventStoreConsumer` constructor takes the following arguments:

- `stream`: The stream to consume.
- `group`: The name of the configured subscription group.
- `handler`: The function to invoke with each incoming event. The `handler` function must take a single `event` argument, which is the raw event as received from Event Store. It must return a promise, which resolves when the event has been processed, or rejects in case of an error. When the promise resolves, the event will be ack'ed with Event Store, and when it rejects the event will be nack'ed with Event Store. See Usage example below.
- `options`: A hash of options:
    - `eventStoreUrl`: The Event Store URL with protocol, domain and port. Example: `http://eventstore.example.com:2113`. If not set, we will default to using `process.env.EVENT_STORE_URL`. And if neither of those are set an exception will be thrown at runtime.
    - `concurrency`: Maximum number of events to handle concurrently. Defaults to `1`, meaning that the consumer won't pull any events from the subscription until the current event has been handled and ack'ed.


Note: You must create the Competing Consumer subscription in Event Store first manually.


### `consumer.start()`

Will tell the consumer to start pulling from the subscription. Nothing happens until you call this function.


### `consumer.stop()`

Tells the consumer to stop pulling. Returns a promise which resolves after all already active events have been handled and ack'ed. After the promise resolves it's safe to stop the Node process.


## Usage example (ES6)

```js
import EventStoreConsumer from 'event-store-consumer'

async function handler(event) {
    //`event` is the raw event from Event Store
    //You can get the event data like this:
    let data = JSON.parse(event.data)

    //The consumer will wait until the `handler` function resolves before ack'ing to Event Store
    await doImportantWork(data)
}

let consumer = new EventStoreConsumer('MyStream', 'my-group', handler, {
    eventStoreUrl: 'http://eventstore.example.com:2113',
    concurrency: 5
})

//Start pulling events
consumer.start()

//Stop after 10 seconds
setTimeout(async function() {
    await consumer.stop()
    console.log('Done for today!')
    process.exit()
}, 10 * 1000)
```
