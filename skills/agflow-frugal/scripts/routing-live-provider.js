#!/usr/bin/env node
'use strict'

// Explicitly opt-in live routing gate. This file is deliberately not a test:
// invoking a configured provider may consume authentication-backed usage.
const fs = require('node:fs')
const path = require('node:path')
const runner = require('./routing-runner.js')
const ag_settings = require('./ag-settings.js')
const provider_adapters = require('./provider-adapters.js')

const result = (status, requirement) => ({ status, requirement, live_provider: true })

const main = async (argv, options = {}) => {
	if (!Array.isArray(argv) || argv[0] !== '--run' || argv[1] !== '--facts' || argv.length !== 3) {
		return result('unavailable', 'live-provider routing requires explicit --run --facts <facts.json> authorization')
	}
	let facts
	try { facts = JSON.parse(fs.readFileSync(path.resolve(argv[2]), 'utf8')) } catch {
		return result('invalid', 'live-provider facts file must contain valid JSON')
	}
	if (facts?.provider_recipes === null || typeof facts?.provider_recipes !== 'object' || Array.isArray(facts.provider_recipes)) return result('unavailable', 'live-provider routing requires an explicit checked provider_recipes object')
	const recipes = Object.values(facts.provider_recipes)
	let config
	const cwd = path.resolve(options.cwd || process.cwd())
	try {
		config = ag_settings.read_json_config(ag_settings.active_config_path(cwd), { repo_root: cwd, active_host: options.active_host })
	} catch {
		return result('unavailable', 'live-provider routing requires a valid current ag.json configuration')
	}
	const configured_ids = new Set(config['external-workers'].map(profile => profile.id))
	if (Object.keys(facts.provider_recipes).some(id => !configured_ids.has(id))) return result('unavailable', 'live-provider recipe references an unconfigured worker profile')
	const configured_recipes = Object.entries(facts.provider_recipes)
		.filter(([id]) => configured_ids.has(id))
		.map(([id, recipe]) => ({ profile: config['external-workers'].find(profile => profile.id === id), recipe }))
	if (configured_recipes.length === 0 || !configured_recipes.some(({ profile, recipe }) => provider_adapters.validate_recipe(profile, recipe).valid)) {
		return result('unavailable', 'live-provider routing requires at least one checked recipe validated as live-provider')
	}
	if (recipes.some(recipe => recipe?.checked === true && recipe.validation !== 'live-provider')) return result('unavailable', 'live-provider routing refuses fixture or unvalidated provider recipes')
	if (!facts.external_execution || typeof facts.external_execution.source_directory !== 'string' || !facts.external_execution.source_directory) return result('unavailable', 'live-provider routing requires an external_execution source_directory and runner configuration')
	let plan
	try { plan = await (options.plan_cli || runner.cli)({ command: 'plan', cwd, facts, active_host: options.active_host }) } catch {
		return result('unavailable', 'live-provider routing could not safely plan the configured cheap-tier invocation')
	}
	if (plan?.status !== 'selected' || plan.selection?.kind !== 'external') return result('unavailable', `live-provider routing could not select a configured external worker: ${plan?.requirement || plan?.status || 'unknown plan result'}`)
	const selected = configured_recipes.find(({ profile }) => profile.id === plan.selection.candidate_id)
	if (!selected) return result('unavailable', 'selected provider profile has no validated live-provider recipe')
	const cheap = provider_adapters.configured_tier(selected.profile, 'cheap')
	if (plan.tier !== 'cheap' || !cheap || plan.selection.actual?.model !== cheap.model || plan.selection.actual?.effort !== cheap.effort) {
		return result('unavailable', 'live-provider smoke runs are limited to the selected profile’s configured cheap tier')
	}
	const stderr = options.stderr || (value => process.stderr.write(value))
	stderr(`WARNING: live provider execution may consume authenticated usage or incur cost. Profile ${selected.profile.id} will use its configured cheap tier (${cheap.model}/${cheap.effort}).\n`)
	return (options.run_cli || runner.cli)({ command: 'run', cwd, facts, active_host: options.active_host })
}

module.exports = { main }

if (require.main === module) main(process.argv.slice(2)).then(value => {
	process.stdout.write(`${JSON.stringify(value)}\n`)
	if (value.status !== 'complete') process.exitCode = 1
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
