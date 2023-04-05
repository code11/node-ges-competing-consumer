
const {expect} = require('chai')
const sinon = require('sinon')
const nock = require('nock')
const {CompetingConsumer, POLL_DELAY} = require('../lib/index.js')

describe('CompetingConsumer', function() {
    let clock

    function expectRead(count, ids) {
        let entries = ids.map(id => {
            return {
                eventId: id,
                links: [
                    {
                        relation: 'ack',
                        uri: 'http://localhost:2113/subscriptions/MyStream/my-service/ack/' + id
                    },
                    {
                        relation: 'nack',
                        uri: 'http://localhost:2113/subscriptions/MyStream/my-service/nack/' + id
                    }
                ]
            }
        })
        return nock('http://localhost:2113')
            .get('/subscriptions/MyStream/my-service/' + count + '?embed=Body')
            .reply(200, {
                entries
            })
    }

    function expectAck(id) {
        return nock('http://localhost:2113')
            .post('/subscriptions/MyStream/my-service/ack/' + id)
            .reply(200)
    }

    function expectNack(id) {
        return nock('http://localhost:2113')
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

    it('requests, acks and nacks', function() {
        let events = []

        //Setup consumer
        let consumer = new CompetingConsumer('MyStream', 'my-service', function(event) {
            events.push(event)
            if (event.eventId === 'ev2') {
                return Promise.reject(new Error('Test error'))
            }
            return Promise.resolve()
        }, {
            concurrency: 5,
            onError(e) {
                if (e.message === 'Test error') {
                    return
                }
                throw e
            }
        })


        let req = expectRead(5, ['ev1', 'ev2'])
        let req2 = expectRead(3, [])
        let ackReq = expectAck('ev1')
        let nackReq = expectNack('ev2')

        //Start it
        consumer.start()
        return waitFor(consumer, 'drain')
            .then(() => {
                req.done()
                req2.done()
                ackReq.done()
                nackReq.done()

                //Check events
                expect(events.length).equal(2)
                expect(events[0].eventId).equal('ev1')
                expect(events[1].eventId).equal('ev2')

                //Stop it
                return consumer.stop()
            })

    })

    it('polls continually', function() {
        //Setup consumer
        let consumer = new CompetingConsumer('MyStream', 'my-service', function() {
        }, {concurrency: 10})

        let req = expectRead(10, [])
        let req2 = expectRead(10, [])
        let req3 = expectRead(10, [])

        //Start it
        consumer.start()
        return waitFor(consumer, 'poll')
            .then(() => {
                req.done()

                //Next poll
                clock.tick(POLL_DELAY)
                return waitFor(consumer, 'poll')
            })
            .then(() => {
                req2.done()

                //One more
                clock.tick(POLL_DELAY)
                return waitFor(consumer, 'poll')
            })
            .then(() => {
                req3.done()

                //Stop it
                return consumer.stop()
            })

    })

    it('eventStoreUrl option wins', function() {
        //Setup consumer
        let consumer = new CompetingConsumer('MyStream', 'my-service',
                        function() {}, {concurrency: 10, eventStoreUrl: 'http://override.localhost:2113'})
        let req = nock('http://override.localhost:2113')
            .get('/subscriptions/MyStream/my-service/10?embed=Body')
            .reply(200, {
                entries: []
            })

        //Start it
        consumer.start()
        return waitFor(consumer, 'poll')
            .then(() => {
                req.done()

                //Stop it
                return consumer.stop()
            })
    })
})
