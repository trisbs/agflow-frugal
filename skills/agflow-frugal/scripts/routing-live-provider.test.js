'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const live = require('./routing-live-provider.js')

test('live-provider routing is unavailable without explicit authorization and never runs by default', async () => {
	const result = await live.main([])
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /explicit --run/)
})
