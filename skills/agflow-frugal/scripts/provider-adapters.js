'use strict'

const usage_policy = require('./usage-policy.js')
const routing_contract = require('./routing-contract.js')

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const text_or_unknown = value => nonempty(value) && value !== 'unknown' ? value : 'unknown'

const configured_tier = (profile, tier) => {
	const value = profile?.tiers?.[tier]
	if (!nonempty(value)) return null
	const separator = value.lastIndexOf('/')
	if (separator < 1 || separator === value.length - 1) return null
	return { model: value.slice(0, separator), effort: value.slice(separator + 1) }
}

const recipe_fields = Object.freeze(['schema_version', 'family', 'tier', 'model', 'effort', 'checked', 'validation'])
const validate_recipe = (profile, recipe) => {
	if (!is_object(profile) || !['codex', 'claude'].includes(profile.family)) return { valid: false, error: 'provider profile family is unsupported' }
	if (!is_object(recipe) || Object.keys(recipe).some(key => !recipe_fields.includes(key))) return { valid: false, error: 'provider recipe must match the version-1 field allowlist' }
	if (recipe.schema_version !== 1 || recipe.family !== profile.family || recipe.checked !== true || recipe.validation !== 'live-provider') return { valid: false, error: 'provider recipe must be checked, version 1, and match the configured live-provider family' }
	const tier = ['cheap', 'basic', 'better', 'best'].includes(recipe.tier) ? configured_tier(profile, recipe.tier) : null
	if (!tier || recipe.model !== tier.model || recipe.effort !== tier.effort) return { valid: false, error: 'provider recipe tier, model, and effort must match its configured tier' }
	if (!Array.isArray(profile.command) || profile.command.length < 2) return { valid: false, error: 'configured provider command is incomplete' }
	const executable = profile.command[0].split(/[\\/]/u).at(-1)
	if (profile.family === 'codex' && (executable !== 'codex' || !profile.command.includes('exec'))) return { valid: false, error: 'Codex provider command must invoke codex exec' }
	if (profile.family === 'claude' && (executable !== 'claude' || !profile.command.includes('-p'))) return { valid: false, error: 'Claude provider command must use print mode' }
	return { valid: true, recipe: { schema_version: 1, family: profile.family, tier: recipe.tier, model: tier.model, effort: tier.effort, checked: true, validation: 'live-provider' } }
}

const validate_recipes = (profile, value) => {
	if (!is_object(value) || !Object.hasOwn(value, 'tiers')) {
		const checked = validate_recipe(profile, value)
		return checked.valid ? { valid: true, recipes: { [checked.recipe.tier]: checked.recipe } } : checked
	}
	if (Object.keys(value).length !== 1 || !is_object(value.tiers) || Object.keys(value.tiers).length === 0) return { valid: false, error: 'provider recipe set must contain only a non-empty tiers object' }
	const recipes = {}
	for (const [tier, recipe] of Object.entries(value.tiers)) {
		const checked = validate_recipe(profile, recipe)
		if (!checked.valid) return checked
		if (tier !== checked.recipe.tier) return { valid: false, error: 'provider recipe key must match its declared tier' }
		recipes[tier] = checked.recipe
	}
	return { valid: true, recipes }
}

const build_invocation = ({ profile, recipe, context, brief }) => {
	const checked = validate_recipe(profile, recipe)
	if (!checked.valid) throw new Error(checked.error)
	if (context?.tier !== checked.recipe.tier) throw new Error('live-provider recipe must match the selected required tier')
	const tier = configured_tier(profile, context?.tier)
	if (!tier) throw new Error(`configured provider profile has no valid ${context?.tier || 'requested'} tier`)
	if (context.selection?.actual?.model !== tier.model || context.selection?.actual?.effort !== tier.effort) throw new Error('selected model and effort do not match the configured provider tier')
	let contract = context.stage === 'assessment'
		? { schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: { material_uncertainty: 'boolean', substantial_mechanical_execution: 'boolean', high_consequence: 'boolean', difficult_rollback: 'boolean', material_disagreement: 'boolean', material_risk: 'boolean', deterministic_verification_sufficient: 'boolean', risk_flags: ['text'], missing_information: ['text'] }, evidence: [{ fact: '<one facts key>', source: '<source>', observation: '<observed fact>' }] }
		: context.stage === 'review'
			? { schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: { material_risk: 'boolean', deterministic_verification_sufficient: 'boolean', reviewer_material_disagreement: 'boolean', viable_alternatives: 'boolean', meaningful_tradeoffs: 'boolean', substantial_consequence: 'boolean', cheap_resolution_exhausted: 'boolean', D: 'integer 0..2', T: 'integer 0..2', I: 'integer 0..2', E: 'integer 0..2', R: 'integer 0..2' }, evidence: [{ fact: '<one facts key>', source: '<source>', observation: '<observed fact>' }] }
			: null
	if (context.stage === 'assessment') {
		const evidence = [{ source_kind: 'ask or repository', source: 'Ask reference or safe repository path', observation: 'observed support for this judgment' }]
		contract.facts.task_plan = { value: 'boolean', changes: [...usage_policy.TASK_PLAN_CHANGES], evidence }
		contract.facts.complexity_reasons = Object.fromEntries(Object.entries(usage_policy.TASK_PLAN_DETAILS).map(([name, fields]) => [name, {
			value: 'true, false, or "unknown"', checked: 'true only after a targeted check', evidence,
			details: { true_fields: fields, false_fields: ['reason'], unknown_fields: ['missing_fact', 'branches'] },
		}]))
	}
	if (context.stage === 'plan-review') contract = { review_envelope: { schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: Object.fromEntries([...routing_contract.definitions.review.boolean, ...routing_contract.definitions.review.scores].map(name => [name, routing_contract.definitions.review.scores.includes(name) ? 'integer 0..2' : 'boolean'])), evidence: [{ fact: 'positive facts key', source: 'source', observation: 'observed support' }] }, findings: [{ id: 'unique text', requirement: 'owner requirement or approved invariant', reproduction: 'reproduction or derivation', reasoning: 'why the requirement fails', evidence: 'checkable source evidence' }] }
	if (context.stage === 'resolution') contract = { plan: 'final plan with acceptance criteria and unresolved options', findings: [{ id: 'review finding id', disposition: 'accepted, rejected, or unresolved', reason: 'evidence and reason for this disposition' }] }
	const prompt = [
		'Execute this single Agentflow stage. Do not delegate or start nested agents.',
		...(context.stage === 'assessment' ? [
			'A task plan creates or substantively changes work order, dependencies, design choices, or acceptance criteria. Listing, reformatting, or explaining an existing settled plan is not a task plan. Cite the frozen Ask in task_plan.evidence. If task_plan.value is false, changes must be [] and complexity_reasons must be {}. If true, list only the requested changes and assess every complexity reason.',
			'For each complexity reason, report true, false, or "unknown", a targeted checked status, and Ask/repository evidence. Use exactly the details fields for its value, not the true_fields/false_fields/unknown_fields labels. False needs a concrete exclusion reason. Unknown needs missing_fact and at least two branches with distinct answer and plan_change; it must describe uncertainty remaining after inspection, not an unperformed check.',
			'Cross-subsystem coordination requires distinct responsibilities, a producer/consumer output dependency, a shared invariant, and joint verification; multiple files alone do not qualify. A public/stored contract needs actual before/after semantics, compatibility, and verification. A trust boundary needs identity, operation, crossing input, boundary, and new control. A material decision needs two viable alternatives and their effect. Material uncertainty needs a named missing fact with answers that change the plan. Do not invent evidence or mark an unperformed check complete.',
			'Return facts only. Do not set execution_class, final_class, or tier; deterministic policy classifies the accepted assessment.',
		] : []),
		['assessment', 'review', 'plan-review', 'resolution'].includes(context.stage) ? 'Return exactly one JSON object matching the required contract. Use the exact frozen task_id and source_identity from the brief. Do not add fields or markdown.' : 'Return only the requested stage result.',
		JSON.stringify({ brief, output_contract: contract || 'stage result', ...(['plan-review', 'resolution'].includes(context.stage) || context.stage === 'primary' && context.routing?.task_plan ? { accepted_inputs: context.facts.records } : {}) }),
	].join('\n\n')
	let arguments_for_provider
	if (profile.family === 'codex') {
		arguments_for_provider = ['--json', '--model', tier.model, '--config', `model_reasoning_effort=${tier.effort}`, prompt]
	} else {
		arguments_for_provider = ['--output-format', 'json', '--model', tier.model, '--effort', tier.effort, prompt]
	}
	return { arguments: arguments_for_provider, model: tier.model, effort: tier.effort, family: profile.family }
}

const parse_codex_jsonl = output => {
	if (typeof output !== 'string' || output.length === 0) return { value: null, observation: { model: 'unknown', effort: 'unknown' }, error: 'Codex JSONL output is empty' }
	const events = []
	for (const line of output.split(/\r?\n/u).filter(Boolean)) {
		try { events.push(JSON.parse(line)) } catch { return { value: null, observation: { model: 'unknown', effort: 'unknown' }, error: 'Codex JSONL output contains an invalid event' } }
	}
	let final_message
	for (const event of events) {
		const payload = event?.msg || event?.payload || event
		if (payload?.type !== 'item.completed') continue
		const item = payload.item || payload
		const details = item.details || item
		if (item.type === 'agent_message' || details.type === 'agent_message' || details.type === 'agentMessage') {
			const text = details.text ?? item.text
			if (typeof text === 'string') final_message = text
		}
	}
	return {
		value: final_message ?? null,
		observation: { model: 'unknown', effort: 'unknown' },
		...(final_message === undefined ? { error: 'Codex JSONL output did not contain a final agent message' } : {}),
	}
}

const parse_claude_json = output => {
	let result
	try { result = JSON.parse(output) } catch { return { value: null, observation: { model: 'unknown', effort: 'unknown' }, error: 'Claude JSON output is invalid' } }
	const message = typeof result?.result === 'string' ? result.result : null
	const model_ids = is_object(result?.modelUsage) ? Object.keys(result.modelUsage).filter(nonempty) : []
	return {
		value: message,
		observation: { model: model_ids.length === 1 ? model_ids[0] : 'unknown', effort: 'unknown' },
		...(message === null ? { error: 'Claude JSON output did not contain a result string' } : {}),
	}
}

const parse_output = (family, output) => family === 'codex' ? parse_codex_jsonl(output) : family === 'claude' ? parse_claude_json(output) : { value: null, observation: { model: 'unknown', effort: 'unknown' }, error: 'provider family is unsupported' }

const missing_identity_fields = family => family === 'claude' ? ['effort'] : ['model', 'effort']

module.exports = { missing_identity_fields, recipe_fields, configured_tier, validate_recipe, validate_recipes, build_invocation, parse_codex_jsonl, parse_claude_json, parse_output }
