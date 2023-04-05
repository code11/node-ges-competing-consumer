const axios = require('axios')
const Queue = require('promise-queue')
const EventEmitter = require('events').EventEmitter

module.exports.POLL_DELAY = 500 //ms

function noop() {
}

function defaultOnError(e) {
    console.error('EventStoreConsumer error: ' + (e.stack || e))
}

class EventStoreConsumer extends EventEmitter {
    constructor(stream, group, handler, {concurrency = 1, eventStoreUrl, onEvent, onAck, onNack, onError} = {}) {
        super()
        this.stream = stream
        this.group = group
        this.handler = handler
        this.concurrency = concurrency
        this.running = false
        this.polling = false
        this.queue = new Queue(this.concurrency, Infinity)

        this.eventStoreUrl = eventStoreUrl || process.env.EVENT_STORE_URL
        if (!this.eventStoreUrl) {
            throw new Error('Event Store URL must be supplied to EventStoreConsumer. Either set the `eventStoreUrl` option or set the `EVENT_STORE_URL` env variable.')
        }

        this.onEvent = onEvent || noop
        this.onAck = onAck || noop
        this.onNack = onNack || noop
        this.onError = onError || defaultOnError
    }

    start() {
        this.running = true
        this.poll()
    }

    stop () {
        this.running = false
        this.cancelScheduledPoll()

        if (this.getQueueLength() === 0) {
            return Promise.resolve()
        } else {
            return new Promise(resolve => {
                this.on('drain', resolve)
            })
        }
    }

    getQueueLength() {
        return this.queue.getQueueLength() + this.queue.getPendingLength()
    }

    poll() {
        //If the queue is already full, then schedule a poll later
        let count = this.concurrency - this.getQueueLength()
        if (count <= 0) {
            this.schedulePoll()
            return
        }

        //Only allow one poll request at a time
        if (this.polling) {
            return
        }
        this.polling = true

        //Make sure that any scheduled polls are cancelled
        this.cancelScheduledPoll()

        //Request up to `count` new events
        let url = `${this.eventStoreUrl}/subscriptions/${this.stream}/${this.group}/${count}?embed=Body`

        this.request('GET', url, {accept: 'application/vnd.eventstore.competingatom+json'})
            .then(payload => {
                this.polling = false

                if (!this.running) {
                    return
                }

                const {entries} = payload.data
                if (entries.length > 0) {
                    //Add each event to the queue
                    entries.forEach(event => {
                        this.queue.add(this.handleEvent.bind(this, event))
                            .then(this.didHandleEvent.bind(this), e => console.log(e.stack))
                    })

                    //Poll immediately
                    this.poll()
                } else {
                    //No events in queue at this time, so let's schedule a poll
                    this.schedulePoll()
                }

                this.emit('poll')
            }, e => {
                this.polling = false
                //Log the error and retry again soon
                this.onError(e)
                if (this.running) {
                    this.schedulePoll()
                }
            })
    }

    schedulePoll() {
        //Only allow one poll to be scheduled at a time
        if (this.pollTimer) {
            return
        }

        this.pollTimer = setTimeout(this.poll.bind(this), this.POLL_DELAY)
    }

    cancelScheduledPoll() {
        clearTimeout(this.pollTimer)
        delete this.pollTimer
    }

    handleEvent(event) {
        this.onEvent(event)
        return Promise.resolve(this.handler(event))
            .then(() => {
                //Ack the event
                return this.ack(event)
            }, e => {
                //Log the error, nack the event
                this.onError(e)
                return this.nack(event)
            })
    }

    didHandleEvent() {
        //Emit a `drain` event if the queue is empty
        if (this.getQueueLength() === 0) {
            this.emit('drain')
        }

        //Try to poll again, if we're still running
        if (this.running) {
            this.poll()
        }
    }

    ack(event) {
        return this.ackNackHelper(event, 'ack')
    }

    nack(event) {
        return this.ackNackHelper(event, 'nack')
    }

    ackNackHelper(event, type) {
        if (type === 'ack') {
            this.onAck(event)
        } else {
            this.onNack(event)
        }
        let url
        for (let i = 0; i < event.links.length; i++) {
            let link = event.links[i]
            if (link.relation === type) {
                url = link.uri
                break
            }
        }
        if (!url) {
            return Promise.resolve()
        }
        return this.request('POST', url)
            .catch(e => {
                //Log the error, but don't throw it since we don't want a failed ack/nack to crash the process
                //TODO: We could retry the ack/nack a few times before giving up
                this.onError(e)
            })
    }

    request(method, url, {accept} = {}) {
        const options = {
            method: method,
            url: url,
            headers: {
                accept
            }
        }
        return axios(options)
            .catch(e => {
                if (e.name === 'StatusCodeError') {
                    let e2 = new Error(`EventStore error ${e.statusCode}: ${e.response.statusMessage}. Method: ${method}. URL: ${url}`)
                    e2.code = 'EVENT_STORE_ERROR'
                    e2.status = e.statusCode
                    throw e2
                }
                throw e
            })
    }
}

module.exports.CompetingConsumer = EventStoreConsumer
