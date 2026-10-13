'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const trace = require('./routing-trace.js')

test('active Codex model accepts only an exact safe slug', () => {
	assert.equal(trace.active_model('gpt-6.1-sol'), 'gpt-6.1-sol')
	assert.equal(trace.active_model('Model_2.preview'), 'Model_2.preview')
	for (const value of [undefined, null, '', '   ', 'GPT 5', 'model/name', 'model\nname', 42, { model: 'gpt-6.1-sol' }, 'a'.repeat(129), 'access_token-secret']) {
		assert.equal(trace.active_model(value), 'unavailable')
	}
})

test('summary trace reports observed stage, tier, profile, and model without raw output', () => {
	const lines = trace.format({
		status: 'complete',
		steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'codex-basic' }],
		facts: { attempts_by_stage: { primary: [{ state: 'completed', actual: { model: 'gpt-5.6-sol', effort: 'low' }, outputs: { result: 'secret prompt body' }, transport: { process: { exit_code: 0 } } }] } },
	})
	assert.deepEqual(lines, [
		'[agf trace] primary | tier=basic | executor=external/codex-basic | model=gpt-5.6-sol | effort=low',
		'[agf trace] outcome=complete',
	])
	assert.equal(lines.some(line => line.includes('secret prompt body')), false)
})

test('summary trace marks unavailable model facts unknown and reports bounded failures without raw errors', () => {
	const lines = trace.format({ status: 'uncertain', stage: 'assessment', requirement: 'token=do-not-print', steps: [] })
	assert.deepEqual(lines, [
		'[agf trace] assessment | status=uncertain',
		'[agf trace] outcome=uncertain',
	])
})

test('plan trace reports selected executor identity without claiming an unobserved model', () => {
	const lines = trace.format({
		status: 'selected',
		stage: 'primary',
		tier: 'cheap',
		selection: { kind: 'host', candidate_id: 'codex-host', actual: { model: 'gpt-5.6-luna', effort: 'low' } },
	})
	assert.deepEqual(lines, [
		'[agf trace] primary | tier=cheap | selected=host/codex-host | model=unknown | effort=unknown',
		'[agf trace] outcome=selected',
	])
})

test('full trace adds only bounded execution facts and rejects terminal control characters', () => {
	const lines = trace.format({
		status: 'complete',
		steps: [{ stage: 'primary', tier: 'cheap', kind: 'external', candidate_id: 'worker\u001b[31m' }],
		facts: { attempts_by_stage: { primary: [{ state: 'completed', actual: { model: 'gpt-5.6-luna', effort: 'low' }, transport: { process: { exit_code: 0 } }, elapsed_ms: 42 }] } },
	}, 'full')
	assert.deepEqual(lines, [
		'[agf trace] primary | tier=cheap | executor=external/worker__31m | model=gpt-5.6-luna | effort=low | state=completed | exit=0 | elapsed_ms=42',
		'[agf trace] outcome=complete',
	])
	assert.equal(lines.every(line => !/[\u0000-\u001f\u007f]/u.test(line)), true)
})

test('trace suppresses credential-shaped model and profile labels', () => {
	const lines = trace.format({
		status: 'complete',
		steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'worker-api-key-123' }],
		facts: { attempts_by_stage: { primary: [{ state: 'completed', actual: { model: 'client-secret-value', effort: 'low' } }] } },
	})
	assert.equal(lines.join('\n').includes('api-key'), false)
	assert.equal(lines.join('\n').includes('client-secret'), false)
	assert.match(lines[0], /executor=external\/unknown \| model=unknown \| effort=low/u)
})
