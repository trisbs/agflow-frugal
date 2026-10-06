'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const execution = require('./routing-execution.js')
const lifecycle = require('./routing-lifecycle.js')
const contract = require('./routing-contract.js')
const state = require('./routing-state.js')

const journey = async (t, options = {}) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-journey-'))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const source = path.join(root, 'source')
	fs.mkdirSync(source)
	const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
	git(['init', '-q'])
	fs.writeFileSync(path.join(source, 'a.txt'), 'original\n')
	git(['add', '.'])
	git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
	const source_identity = { source_kind: 'git', value: git(['rev-parse', 'HEAD']) }
	const switches = { 'allowed-worker': ['external'], 'review-policy': 'prefer-independent', 'cli-provider': 'on' }
	const facts = {
		source_identity,
		config: { switches },
		policy: switches,
		host: { id: 'codex', family: 'codex' },
		admission_facts: options.cheap
			? { simple: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true }
			: { material_uncertainty: true },
		task: { task_id: 'journey', brief: { goal: 'Update the fixture' }, work_boundary: ['a.txt'], interactive_host: false },
		briefs: { assessment: { goal: 'Assess the fixture without source writes' } },
		capabilities: { external: [{
			id: 'fixture', candidate_id: 'fixture', family: 'codex', available: true, recipe_checked: true,
			command: [process.execPath], controls: { read_only: true },
			tiers: { cheap: 'fixture/low', basic: 'fixture/low', better: 'fixture/low' },
		}] },
		records: {},
	}
	const launches = []
	const external = async context => {
		launches.push({ stage: context.stage, tier: context.tier })
		const assessment = Object.fromEntries(contract.definitions.assessment.boolean.map(key => [key,
			key === 'material_uncertainty' || key === 'deterministic_verification_sufficient' ||
			key === 'substantial_mechanical_execution' && options.substantial === true,
		]))
		Object.assign(assessment, { risk_flags: [], missing_information: [] })
		const output = context.stage === 'assessment' ? {
			schema_version: 1, task_id: context.task.task_id, source_identity, facts: assessment,
			evidence: Object.entries(assessment).filter(([, value]) => value === true).map(([fact]) =>
				({ fact, source: 'fixture', observation: 'Named deterministic fixture condition' })),
		} : { result: 'implemented' }
		const write = context.stage === 'primary' || options.assessment_write === true
		const expected = write ? 'implemented\n' : 'original\n'
		const command = [process.execPath, '-e',
			'const fs=require("node:fs");if(fs.readFileSync("a.txt","utf8")!==' + JSON.stringify(expected) + ')process.exit(1)',
		]
		const program = [
			'const fs=require("node:fs")',
			...(write ? ['fs.writeFileSync("a.txt","implemented\\n")'] : []),
			'process.stdout.write(' + JSON.stringify(JSON.stringify(options.malformed ? {} : output)) + ')',
		].join(';')
		return execution.external_adapter({
			source_directory: source,
			runner_options: { clone_directory: path.join(root, 'clone-' + launches.length) },
			allow_fixture_recipe: true,
			read_only_recipe_for_stage: () => ({
				schema_version: 1, provider: 'fixture-node', source_access: 'read-only',
				arguments: ['--input-type=commonjs'], validation: 'fixture',
			}),
			arguments_for_stage: () => ['-e', program],
			verification_for_stage: () => [command],
			verify_stage: async ({ runner, root: clone_root, commands }) => {
				assert.equal(runner.clone.independent, true)
				assert.deepEqual(runner.clone.remotes, [])
				assert.notEqual(clone_root, source)
				return { coordinator_inspected: true, results: commands.map(command => {
					execFileSync(command[0], command.slice(1), { cwd: clone_root })
					return { command, passed: true }
				}) }
			},
		})(context)
	}
	const result = await lifecycle.run_lifecycle(facts, { external })
	const workspace = path.join(root, 'workspace')
	state.save(workspace, 'journey', result.facts)
	const saved = state.load(workspace, 'journey').state
	assert.deepEqual(saved.records, result.facts.records)
	assert.deepEqual(saved.attempts, result.facts.attempts)
	assert.deepEqual(saved.usage, result.facts.usage)
	assert.equal(saved.attempts.length, launches.length)
	assert.equal(fs.readFileSync(path.join(source, 'a.txt'), 'utf8'), 'original\n')
	assert.equal(git(['rev-parse', 'HEAD']), source_identity.value)
	return { result, launches, saved }
}

for (const [name, options, execution_class, stages] of [
	['L1 Cheap Direct', { cheap: true }, 'L1', ['primary']],
	['L2 Basic assessment and primary', {}, 'L2', ['assessment', 'primary']],
	['L3 Basic assessment and bounded execution', { substantial: true }, 'L3', ['assessment', 'primary']],
]) {
	test(name, async t => {
		const { result, launches, saved } = await journey(t, options)
		assert.equal(result.status, 'complete')
		assert.equal(result.routing.execution_class, execution_class)
		assert.deepEqual(launches.map(item => item.stage), stages)
		assert.deepEqual(launches.map(item => item.tier), stages.map(() => options.cheap ? 'cheap' : 'basic'))
		assert.deepEqual(Object.keys(saved.records), stages)
		assert.deepEqual(saved.records.primary.changed_paths, ['a.txt'])
		assert.equal(saved.usage.external_workers, 1)
		assert.equal(saved.usage.discovery_iterations, options.cheap ? 0 : 1)
		for (const record of saved.attempts) {
			assert.equal(record.acceptance.accepted, true)
			assert.equal(record.transport.runner_id, 'external-runner-v1')
			assert.ok(Number.isInteger(record.transport.process.pid))
		}
	})
}

for (const [name, options, reason] of [
	['malformed assessment cannot advance', { malformed: true }, /schema_version/],
	['source write during assessment cannot advance', { assessment_write: true }, /assessment changed source paths/],
]) {
	test(name, async t => {
		const { result, launches, saved } = await journey(t, options)
		assert.equal(result.status, 'task-failed')
		assert.deepEqual(launches, [{ stage: 'assessment', tier: 'basic' }])
		assert.deepEqual(saved.records, {})
		assert.equal(saved.attempts[0].acceptance.accepted, false)
		assert.match(saved.attempts[0].reason, reason)
		assert.equal(saved.usage.discovery_iterations, 0)
	})
}
