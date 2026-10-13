'use strict'

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
	const cheap = configured_tier(profile, 'cheap')
	if (recipe.tier !== 'cheap' || !cheap || recipe.model !== cheap.model || recipe.effort !== cheap.effort) return { valid: false, error: 'provider recipe tier, model, and effort must match the configured cheap tier' }
	if (!Array.isArray(profile.command) || profile.command.length < 2) return { valid: false, error: 'configured provider command is incomplete' }
	const executable = profile.command[0].split(/[\\/]/u).at(-1)
	if (profile.family === 'codex' && (executable !== 'codex' || !profile.command.includes('exec'))) return { valid: false, error: 'Codex provider command must invoke codex exec' }
	if (profile.family === 'claude' && (executable !== 'claude' || !profile.command.includes('-p'))) return { valid: false, error: 'Claude provider command must use print mode' }
	return { valid: true, recipe: { schema_version: 1, family: profile.family, tier: 'cheap', model: cheap.model, effort: cheap.effort, checked: true, validation: 'live-provider' } }
}

const build_invocation = ({ profile, recipe, context, brief }) => {
	const checked = validate_recipe(profile, recipe)
	if (!checked.valid) throw new Error(checked.error)
	if (context?.tier !== 'cheap') throw new Error('live-provider invocations are restricted to the configured cheap tier')
	const tier = configured_tier(profile, context?.tier)
	if (!tier) throw new Error(`configured provider profile has no valid ${context?.tier || 'requested'} tier`)
	if (context.selection?.actual?.model !== tier.model || context.selection?.actual?.effort !== tier.effort) throw new Error('selected model and effort do not match the configured provider tier')
	const contract = context.stage === 'assessment'
		? { schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: { material_uncertainty: 'boolean', substantial_mechanical_execution: 'boolean', high_consequence: 'boolean', difficult_rollback: 'boolean', material_disagreement: 'boolean', material_risk: 'boolean', deterministic_verification_sufficient: 'boolean', risk_flags: ['text'], missing_information: ['text'] }, evidence: [{ fact: '<one facts key>', source: '<source>', observation: '<observed fact>' }] }
		: context.stage === 'review'
			? { schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: { material_risk: 'boolean', deterministic_verification_sufficient: 'boolean', reviewer_material_disagreement: 'boolean', viable_alternatives: 'boolean', meaningful_tradeoffs: 'boolean', substantial_consequence: 'boolean', cheap_resolution_exhausted: 'boolean', D: 'integer 0..2', T: 'integer 0..2', I: 'integer 0..2', E: 'integer 0..2', R: 'integer 0..2' }, evidence: [{ fact: '<one facts key>', source: '<source>', observation: '<observed fact>' }] }
			: null
	const prompt = [
		'Execute this single Agentflow stage. Do not delegate or start nested agents.',
		context.stage === 'assessment' || context.stage === 'review' ? 'Return exactly one JSON object matching the required contract. Use the exact frozen task_id and source_identity from the brief. Do not add fields or markdown.' : 'Return only the requested stage result.',
		JSON.stringify({ brief, output_contract: contract || 'stage result' }),
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

module.exports = { recipe_fields, configured_tier, validate_recipe, build_invocation, parse_codex_jsonl, parse_claude_json, parse_output }
