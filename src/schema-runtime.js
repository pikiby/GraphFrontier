// Configure the shared Zod runtime before SDK or application schemas are created.
require('zod/v4/core').config({ jitless: true });

module.exports = require('zod');
