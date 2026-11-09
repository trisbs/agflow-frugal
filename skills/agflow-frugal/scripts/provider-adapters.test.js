'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const settings = require('./ag-settings.js')
const adapters = require('./provider-adapters.js')

const context_for = (profile, tier = 'cheap') => {
	const [model, effort] = profile.tiers[tier].split('/')
	return { tier, stage: 'primary', selection: { actual: { model, effort } } }
}
const recipe_for = profile => {
	const tier = adapters.configured_tier(profile, 'cheap')
	return { schema_version: 1, family: profile.family, tier: 'cheap', ...tier, checked: true, validation: 'live-provider' }
}

test('provider recipe must match its configured family and versioned live contract', () => {
	const profile = settings.make_template('codex')['external-workers'][0]
	assert.equal(adapters.validate_recipe(profile, recipe_for(profile)).valid, true)
	assert.equal(adapters.validate_recipe(profile, { ...recipe_for(profile), family: 'claude' }).valid, false)
	assert.equal(adapters.validate_recipe(profile, { ...recipe_for(profile), arguments: ['--model', 'untrusted'] }).valid, false)
	assert.equal(adapters.validate_recipe(profile, { ...recipe_for(profile), model: 'unconfigured-model' }).valid, false)
})

test('Codex invocation explicitly applies configured cheap model and effort', () => {
	const profile = settings.make_template('codex')['external-workers'][0]
	const invocation = adapters.build_invocation({ profile, recipe: recipe_for(profile), context: context_for(profile), brief: { stage: 'primary' } })
	assert.deepEqual(invocation.arguments.slice(0, 5), ['--json', '--model', profile.tiers.cheap.split('/')[0], '--config', `model_reasoning_effort=${profile.tiers.cheap.split('/')[1]}`])
	assert.match(invocation.arguments.at(-1), /"stage":"primary"/)
})

test('Claude invocation explicitly applies configured cheap model and effort', () => {
	const profile = settings.make_template('claude')['external-workers'][0]
	const invocation = adapters.build_invocation({ profile, recipe: recipe_for(profile), context: context_for(profile), brief: { stage: 'primary' } })
	assert.deepEqual(invocation.arguments.slice(0, 6), ['--output-format', 'json', '--model', profile.tiers.cheap.split('/')[0], '--effort', profile.tiers.cheap.split('/')[1]])
	assert.match(invocation.arguments.at(-1), /"stage":"primary"/)
})

test('provider invocation refuses mismatched selected identity and recipe tier', () => {
	const profile = settings.make_template('codex')['external-workers'][0]
	const context = context_for(profile)
	assert.throws(() => adapters.build_invocation({ profile, recipe: recipe_for(profile), context: { ...context, selection: { actual: { model: 'wrong', effort: 'low' } } }, brief: {} }), /do not match/)
	assert.throws(() => adapters.build_invocation({ profile, recipe: recipe_for(profile), context: context_for(profile, 'basic'), brief: {} }), /recipe must match the selected required tier/)
})

test('Codex JSONL parser extracts final agent output but keeps identity unknown', () => {
	const parsed = adapters.parse_output('codex', [
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"ok"}' } }),
		'',
	].join('\n'))
	assert.equal(parsed.value, '{"answer":"ok"}')
	assert.deepEqual(parsed.observation, { model: 'unknown', effort: 'unknown' })
})

test('Claude JSON parser reports one provider-emitted model and never infers effort', () => {
	const parsed = adapters.parse_output('claude', JSON.stringify({ result: '{"answer":"ok"}', modelUsage: { 'claude-haiku-test': { inputTokens: 1 } } }))
	assert.equal(parsed.value, '{"answer":"ok"}')
	assert.deepEqual(parsed.observation, { model: 'claude-haiku-test', effort: 'unknown' })
	const mixed = adapters.parse_output('claude', JSON.stringify({ result: 'ok', modelUsage: { first: {}, second: {} } }))
	assert.equal(mixed.observation.model, 'unknown')
})

test('checked Basic recipes build the selected provider tier', () => {
	for (const family of ['codex', 'claude']) {
		const profile = settings.make_template(family)['external-workers'].find(value => value.family === family)
		const recipe = { ...recipe_for(profile), tier: 'basic', ...adapters.configured_tier(profile, 'basic') }
		const invocation = adapters.build_invocation({ profile, recipe, context: context_for(profile, 'basic'), brief: {} })
		assert.equal(invocation.model, recipe.model)
		assert.equal(invocation.effort, recipe.effort)
		assert.throws(() => adapters.build_invocation({ profile, recipe: recipe_for(profile), context: context_for(profile, 'basic'), brief: {} }), /tier/)
	}
})

test('recipe sets preserve single-recipe compatibility and validate every tier entry', () => {
	const profile = settings.make_template('codex')['external-workers'][0]
	const cheap = recipe_for(profile)
	const basic = { ...cheap, tier: 'basic', ...adapters.configured_tier(profile, 'basic') }
	const better = { ...cheap, tier: 'better', ...adapters.configured_tier(profile, 'better') }
	assert.deepEqual(adapters.validate_recipes(profile, cheap).recipes, { cheap })
	assert.deepEqual(adapters.validate_recipes(profile, { tiers: { basic, better } }).recipes, { basic, better })
	for (const value of [
		{ tiers: {} }, { tiers: null }, { tiers: { basic }, checked: true },
		{ tiers: { basic: cheap } }, { tiers: { basic: { ...basic, model: 'wrong' } } },
		{ tiers: { basic: { ...basic, checked: false } } }, { tiers: { basic: { ...basic, validation: 'fixture' } } },
	]) assert.equal(adapters.validate_recipes(profile, value).valid, false)
})

test('production assessment prompt requests the shared plan rubric without authorizing model classification', () => {
	const profile = settings.make_template('codex')['external-workers'][0]
	const context = { ...context_for(profile), stage: 'assessment' }
	const invocation = adapters.build_invocation({ profile, recipe: recipe_for(profile), context, brief: { task_id: 'plan:assessment', source_identity: { source_kind: 'git', value: 'a'.repeat(40) } } })
	const prompt = invocation.arguments.at(-1)
	const output = JSON.parse(prompt.split('\n\n').at(-1)).output_contract
	assert.deepEqual(output.facts.task_plan.changes, ['work_sequence', 'dependencies', 'design_choices', 'acceptance_criteria'])
	assert.deepEqual(Object.keys(output.facts.complexity_reasons), ['material_uncertainty', 'cross_subsystem_coordination', 'public_or_stored_data_contract', 'trust_boundary', 'unresolved_material_decision'])
	assert.match(prompt, /multiple files alone do not qualify/)
	assert.match(prompt, /uncertainty remaining after inspection/)
	assert.match(prompt, /Do not set execution_class, final_class, or tier/)
})
