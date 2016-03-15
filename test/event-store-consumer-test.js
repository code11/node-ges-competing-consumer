import {expect} from 'chai'
import sinon from 'sinon'
import nock from 'nock'
import EventStoreConsumer from '../lib'
import {POLL_DELAY} from '../lib'

describe('EventStoreConsumer', function() {
    let clock

    function expectRead(count, ids) {
        let entries = ids.map(id => {
            return {
                eventId: id,
                links: [
                    {
                        relation: 'ack',
                        uri: 'http://eventstore.test:2113/subscriptions/MyStream/my-service/ack/' + id
                    },
                    {
                        relation: 'nack',
                        uri: 'http://eventstore.test:2113/subscriptions/MyStream/my-service/nack/' + id
                    }
                ]
            }
        })
        return nock('http://eventstore.test:2113')
            .get('/subscriptions/MyStream/my-service/' + count + '?embed=Body')
            .reply(200, {
                entries
            })
    }

    function expectAck(id) {
        return nock('http://eventstore.test:2113')
            .post('/subscriptions/MyStream/my-service/ack/' + id)
            .reply(200)
    }

    function expectNack(id) {
        return nock('http://eventstore.test:2113')
            .post('/subscriptions/MyStream/my-service/nack/' + id)
            .reply(200)
    }

    function waitFor(consumer, event) {
        return new Promise(resolve => {
            consumer.on(event, resolve)
        })
    }

    before(() => {
        clock = sinon.useFakeTimers()
        nock.disableNetConnect()
    })

    after(() => {
        clock.restore()
        nock.cleanAll()
        nock.enableNetConnect()
    })

    it('requests, acks and nacks', async function() {
        let events = []

        //Setup consumer
        let consumer = new EventStoreConsumer('MyStream', 'my-service', async function(event) {
            events.push(event)
            if (event.eventId === 'ev2') {
                throw new Error('Test error')
            }
        }, {concurrency: 5})

        //Start it
        let req = expectRead(5, ['ev1', 'ev2'])
        let req2 = expectRead(3, [])
        let ackReq = expectAck('ev1')
        let nackReq = expectNack('ev2')
        consumer.start()
        await waitFor(consumer, 'drain')
        req.done()
        req2.done()
        ackReq.done()
        nackReq.done()

        //Check events
        expect(events.length).equal(2)
        expect(events[0].eventId).equal('ev1')
        expect(events[1].eventId).equal('ev2')

        //Stop it
        await consumer.stop()
    })

    it('polls continually', async function() {
        //Setup consumer
        let consumer = new EventStoreConsumer('MyStream', 'my-service', async function() {
        }, {concurrency: 10})

        //Start it
        let req = expectRead(10, [])
        consumer.start()
        await waitFor(consumer, 'poll')
        req.done()

        //Next poll
        let req2 = expectRead(10, [])
        clock.tick(POLL_TIMEOUT)
        await waitFor(consumer, 'poll')
        req2.done()

        //One more
        let req3 = expectRead(10, [])
        clock.tick(POLL_TIMEOUT)
        await waitFor(consumer, 'poll')
        req3.done()

        //Stop it
        await consumer.stop()
    })

    it('eventStoreUrl option wins', async function() {
        //Setup consumer
        let consumer = new EventStoreConsumer('MyStream', 'my-service', async function() {
        }, {concurrency: 10, eventStoreUrl: 'http://override.eventstore.test:2113'})

        //Start it
        let req = nock('http://override.eventstore.test:2113')
            .get('/subscriptions/MyStream/my-service/10?embed=Body')
            .reply(200, {
                entries: []
            })
        consumer.start()
        await waitFor(consumer, 'poll')
        req.done()

        //Stop it
        await consumer.stop()
    })
})
