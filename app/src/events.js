const EventEmitter = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
