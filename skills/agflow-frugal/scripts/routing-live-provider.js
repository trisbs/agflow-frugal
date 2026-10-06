#!/usr/bin/env node
'use strict'

// Explicitly opt-in live routing gate. This file is deliberately not a test:
// invoking a configured provider may consume authentication-backed usage.
const fs = require('node:fs')
const path = require('node:path')
const runner = require('./routing-runner.js')

const result = (status, requirement) => ({ status, requirement, live_provider: true })

const main = async (argv, options = {}) => {
	if (!Array.isArray(argv) || argv[0] !== '--run' || argv[1] !== '--facts' || argv.length !== 3) {
		return result('unavailable', 'live-provider routing requires explicit --run --facts <facts.json> authorization')
	}
	let facts
	try { facts = JSON.parse(fs.readFileSync(path.resolve(argv[2]), 'utf8')) } catch {
		return result('invalid', 'live-provider facts file must contain valid JSON')
	}
	if (facts?.provider_recipes === null || typeof facts?.provider_recipes !== 'object') return result('unavailable', 'live-provider routing requires an explicit checked provider_recipes object')
	for (const recipe of Object.values(facts.provider_recipes)) {
		if (recipe?.checked === true && recipe.validation !== 'live-provider') return result('unavailable', 'live-provider routing refuses fixture or unvalidated provider recipes')
	}
	return runner.cli({ command: 'run', cwd: options.cwd || process.cwd(), facts })
}

module.exports = { main }

if (require.main === module) main(process.argv.slice(2)).then(value => {
	process.stdout.write(`${JSON.stringify(value)}\n`)
	if (value.status !== 'complete') process.exitCode = 1
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
