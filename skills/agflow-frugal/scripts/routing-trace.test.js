'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const trace = require('./routing-trace.js')
const coordinator = require('./routing-coordinator.js')
const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }

const direct_basic_facts = () => ({
	source_identity,
	policy: { 'allowed-worker': ['external'], 'review-policy': 'prefer-independent', 'cli-provider': 'on' },
	config: { switches: { 'allowed-worker': ['external'], 'review-policy': 'prefer-independent', 'cli-provider': 'on' }, 'pipeline-roles': { implementation: 'basic' } },
	host: { id: 'codex', family: 'codex' },
	capabilities: { external: [{ candidate_id: 'codex-worker', id: 'codex-worker', family: 'codex', available: true, recipe_checked: true, command: ['codex', 'exec'], tiers: { basic: 'gpt-basic/medium' } }] },
	admission_facts: {
		task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Run a bounded task' }] },
		complexity_reasons: {},
		mechanical: false,
		simple: false,
		requirement_clear: true,
		scope_known: true,
		reversible: true,
		deterministic_verification: false,
		material_uncertainty: true,
		risk_flags: [],
		missing_information: [],
	},
	task: { task_id: 'trace-task', role: 'implementation', brief: { goal: 'Run a bounded task' }, work_boundary: ['src/a.js'] },
	briefs: { assessment: { goal: 'Assess task' }, review: { goal: 'Review task' } },
	records: {},
})

const failed_basic_attempt = facts => {
	const selected = coordinator.plan_next_action(facts)
	return {
		record_version: 1,
		task_id: coordinator.stage_task_id(facts.task.task_id, 'primary'),
		attempt_id: 'trace-attempt',
		candidate_id: selected.selection.candidate_id,
		kind: selected.selection.kind,
		role: selected.task.role,
		source_identity,
		requested: selected.selection.requested,
		actual: selected.selection.actual,
		dispatched: { ...selected.selection.actual, stage: 'primary', tier: 'basic', profile: selected.selection.candidate_id, invocation_digest: 'a'.repeat(64), provenance: 'configured-provider-invocation-v1' },
		stage_input_digest: selected.task.stage_input_digest,
		state: 'task-failed',
		outputs: { error: 'worker failed after start' },
		changed_paths: [],
		acceptance: { checks_run: true, coordinator_inspected: true, accepted: false },
		limitations: [],
		transport: { runner_id: 'external-runner-v1', worker_started: true, process: { pid: 123, exit_code: 1 } },
	}
}

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
		facts: { attempts_by_stage: { primary: [{ candidate_id: 'codex-basic', state: 'completed', actual: { model: 'gpt-5.6-sol', effort: 'low' }, outputs: { result: 'secret prompt body' }, transport: { process: { exit_code: 0 } } }] } },
	})
	assert.deepEqual(lines, [
		'[agf trace] primary | class=unknown | tier=basic | executor=external/codex-basic | profile=codex-basic | dispatch_model=unknown | dispatch_effort=unknown | process_started=unknown | accepted=unknown | result=completed | exit=0',
		'[agf trace] outcome=unverified',
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

test('failed trace separates process start, coordinator acceptance, and normalized failure evidence', () => {
	const lines = trace.format({
		status: 'task-failed',
		routing: { execution_class: 'L3' },
		steps: [{ stage: 'assessment', tier: 'basic', kind: 'external', candidate_id: 'worker' }],
		facts: {
			attempts_by_stage: {
				assessment: [{
					kind: 'external',
					candidate_id: 'worker',
					requested: { tier: 'basic' },
					state: 'task-failed',
					acceptance: { accepted: false },
					transport: {
						worker_started: true,
						process: { pid: 101, exit_code: 1 },
						failure: {
							version: 1,
							outcome: 'nonzero_exit',
							clue: 'read_only_filesystem',
							clue_source: 'stderr_indicator',
							stderr_bytes: 71,
							stderr_truncated: false,
							recovery_hint: 'Use an executor runtime with writable state, then authorize a new attempt.',
						},
					},
				}],
			},
		},
	})
	assert.match(lines[0], /class=unverified.*basic_assessment_accepted=false.*process_started=true.*accepted=false.*failure=nonzero_exit.*clue=read_only_filesystem/)
	assert.equal(lines.at(-1), '[agf trace] outcome=task-failed')
	assert.equal(lines.join('\n').includes('worker_started='), false)
})

test('plan trace reports selected executor identity without claiming an unobserved model', () => {
	const lines = trace.format({
		status: 'selected',
		stage: 'primary',
		tier: 'cheap',
		selection: { kind: 'host', candidate_id: 'codex-host', actual: { model: 'gpt-5.6-luna', effort: 'low' } },
	})
	assert.deepEqual(lines, [
		'[agf trace] primary | class=unknown | tier=cheap | selected=host/codex-host | profile=codex-host | dispatch_model=unknown | dispatch_effort=unknown | process_started=false | accepted=unknown | result=selected',
		'[agf trace] outcome=selected',
	])
})

test('full trace adds only bounded execution facts and rejects terminal control characters', () => {
	const lines = trace.format({
		status: 'complete',
		steps: [{ stage: 'primary', tier: 'cheap', kind: 'external', candidate_id: 'worker\u001b[31m' }],
		facts: { attempts_by_stage: { primary: [{ candidate_id: 'worker\u001b[31m', state: 'completed', actual: { model: 'gpt-5.6-luna', effort: 'low' }, transport: { process: { exit_code: 0 } }, elapsed_ms: 42 }] } },
	}, 'full')
	assert.deepEqual(lines, [
		'[agf trace] primary | class=unknown | tier=cheap | executor=external/worker__31m | profile=worker__31m | dispatch_model=unknown | dispatch_effort=unknown | process_started=unknown | accepted=unknown | result=completed | exit=0 | observed_model=gpt-5.6-luna | observed_effort=low | elapsed_ms=42',
		'[agf trace] outcome=unverified',
	])
	assert.equal(lines.every(line => !/[\u0000-\u001f\u007f]/u.test(line)), true)
})

test('trace suppresses credential-shaped model and profile labels', () => {
	const lines = trace.format({
		status: 'complete',
		steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'worker-api-key-123' }],
		facts: { attempts_by_stage: { primary: [{ candidate_id: 'worker-api-key-123', state: 'completed', actual: { model: 'client-secret-value', effort: 'low' } }] } },
	})
	assert.equal(lines.join('\n').includes('api-key'), false)
	assert.equal(lines.join('\n').includes('client-secret'), false)
	assert.match(lines[0], /executor=external\/unknown \| profile=unknown \| dispatch_model=unknown/u)
})

 test('dispatch trace distinguishes selected, started, completed and failed stage evidence', () => {
	for (const state of ['completed', 'task-failed', 'unavailable']) {
		const started = state !== 'unavailable'
		const lines = trace.format({ status: state === 'completed' ? 'complete' : state, routing: { execution_class: 'L4' }, steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'worker' }], facts: { attempts_by_stage: { primary: [{ kind: 'external', candidate_id: 'worker', requested: { tier: 'basic' }, state, dispatched: { tier: 'basic', profile: 'worker', model: 'fixed-basic', effort: 'medium' }, actual: { model: 'unknown', effort: 'unknown' }, transport: { worker_started: started, process: { exit_code: started ? 0 : null } } }] } } })
		assert.match(lines[0], /class=unverified.*basic_assessment_accepted=false.*required_tier=basic.*tier=basic.*profile=worker.*dispatch_model=fixed-basic.*dispatch_effort=medium/)
		assert.ok(lines[0].includes(`process_started=${started}`))
		assert.ok(lines[0].includes('accepted=unknown'))
		assert.ok(lines[0].includes(`result=${state}`))
		assert.equal(lines.at(-1), `[agf trace] outcome=${state === 'completed' ? 'unverified' : state}`)
	}
})

test('direct Basic primary traces keep class unverified when no Basic assessment record exists', () => {
	const lines = trace.format({
		status: 'complete',
		routing: { execution_class: 'L3' },
		steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'worker' }],
		facts: { attempts_by_stage: { primary: [{ kind: 'external', candidate_id: 'worker', requested: { tier: 'basic' }, state: 'completed', acceptance: { accepted: true }, transport: { worker_started: true, process: { pid: 101, exit_code: 0 } } }] } },
	})
	assert.match(lines[0], /class=unverified.*basic_assessment_accepted=false.*required_tier=basic/)
	assert.equal(lines.at(-1), '[agf trace] outcome=unverified')
})

test('unvalidated attempts cannot establish an L2-L5 class or Basic start', () => {
	for (const attempt of [
		{ kind: 'external', requested: { tier: 'cheap' }, transport: { worker_started: true } },
		{ kind: 'host', requested: { tier: 'basic' }, transport: { worker_started: true } },
		{ kind: 'external', requested: { tier: 'basic' }, transport: { worker_started: false } },
	]) {
		const lines = trace.format({
			status: 'complete',
			routing: { execution_class: 'L3' },
			steps: [{ stage: 'primary', tier: 'basic', kind: attempt.kind, candidate_id: 'worker' }],
			facts: { attempts_by_stage: { assessment: [attempt] } },
		})
		assert.match(lines[0], /class=unverified.*basic_assessment_accepted=false.*required_tier=basic/)
		assert.equal(lines.at(-1), '[agf trace] outcome=unverified')
	}

	const started = trace.format({
		status: 'selected',
		routing: { execution_class: 'L3' },
		stage: 'primary', tier: 'basic',
		selection: { kind: 'external', candidate_id: 'worker' },
		facts: { attempts_by_stage: { assessment: [{ kind: 'external', requested: { tier: 'basic' }, transport: { worker_started: true } }] } },
	})
	assert.match(started[0], /class=unverified.*basic_assessment_accepted=false.*process_started=false/)
})

test('only a primary start validated against the frozen route can establish direct Basic class', () => {
	const valid_facts = direct_basic_facts()
	const valid_attempt = failed_basic_attempt(valid_facts)
	valid_facts.attempts_by_stage = { primary: [valid_attempt] }
	const valid_result = { status: 'task-failed', facts: valid_facts, steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'codex-worker' }] }
	const valid_lines = trace.format(valid_result)
	assert.match(valid_lines[0], /class=L2 \| basic_primary_started=true/u)
	assert.equal(trace.basic_worker_started(valid_result), true)

	for (const mutate of [
		attempt => { attempt.task_id = 'other:primary' },
		attempt => { attempt.source_identity = { source_kind: 'git', value: 'f'.repeat(40) } },
		attempt => { attempt.stage_input_digest = 'f'.repeat(64) },
		attempt => { attempt.dispatched.stage = 'review' },
	]) {
		const facts = direct_basic_facts()
		const attempt = failed_basic_attempt(facts)
		mutate(attempt)
		facts.attempts_by_stage = { primary: [attempt] }
		const result = { status: 'task-failed', facts, steps: [{ stage: 'primary', tier: 'basic', kind: 'external', candidate_id: 'codex-worker' }] }
		assert.match(trace.format(result)[0], /class=unverified \| basic_primary_started=false/u)
		assert.equal(trace.basic_worker_started(result), false)
	}
})
