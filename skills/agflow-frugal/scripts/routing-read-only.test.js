'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const read_only = require('./routing-read-only.js')

const fixture_recipe = () => ({
	schema_version: 1,
	provider: 'fixture-cli',
	source_access: 'read-only',
	arguments: ['--sandbox', 'read-only'],
	validation: 'fixture',
})

test('read-only recipe normalizes a canonical fixture and creates bounded dispatch proof', () => {
	const checked = read_only.validate_recipe(fixture_recipe())
	assert.equal(checked.valid, true)
	const result = read_only.create_dispatch_proof(
		checked.recipe,
		['fixture-cli', 'exec', '--sandbox', 'read-only', 'inspect'],
	)
	assert.equal(result.valid, true)
	assert.deepEqual(result.proof.applied_arguments, ['--sandbox', 'read-only'])
	assert.equal(result.proof.command_index, 2)
	assert.equal(result.proof.validation, 'fixture')
	assert.equal(result.proof.os_confinement, 'not-proven')
	assert.equal(read_only.validate_dispatch_proof(result.proof).valid, true)
})

test('read-only recipe rejects unknown fields, malformed arguments, and unapplied controls', () => {
	const unknown = { ...fixture_recipe(), accepted: true }
	assert.match(read_only.validate_recipe(unknown).error, /unknown field/)
	const malformed = { ...fixture_recipe(), arguments: ['--sandbox', 'read-only\nunsafe'] }
	assert.match(read_only.validate_recipe(malformed).error, /literal strings/)
	const unapplied = read_only.create_dispatch_proof(fixture_recipe(), ['fixture-cli', 'exec', 'inspect'])
	assert.match(unapplied.error, /not applied/)
})

test('fixture proof cannot claim live or environmental isolation', () => {
	const result = read_only.create_dispatch_proof(
		fixture_recipe(),
		['fixture-cli', 'exec', '--sandbox', 'read-only'],
	)
	const forged = { ...result.proof, os_confinement: 'proven' }
	assert.match(read_only.validate_dispatch_proof(forged).error, /not-proven/)
})
