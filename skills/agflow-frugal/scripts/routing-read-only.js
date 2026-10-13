'use strict'

const crypto = require('node:crypto')

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const literal_argument = value => text(value) && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const recipe_fields = Object.freeze(['schema_version', 'provider', 'source_access', 'arguments', 'validation'])
const proof_fields = Object.freeze([
	'schema_version',
	'kind',
	'provider',
	'source_access',
	'applied_arguments',
	'command_index',
	'recipe_digest',
	'validation',
	'os_confinement',
	'network_isolation',
	'credential_isolation',
])

const validate_recipe = value => {
	if (!is_object(value)) return { valid: false, error: 'read-only recipe must be an object' }
	if (Object.keys(value).some(key => !recipe_fields.includes(key))) return { valid: false, error: 'read-only recipe contains an unknown field' }
	if (value.schema_version !== 1) return { valid: false, error: 'read-only recipe schema_version must be 1' }
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.provider || '')) return { valid: false, error: 'read-only recipe provider must be a stable identifier' }
	if (value.source_access !== 'read-only') return { valid: false, error: 'read-only recipe source_access must be read-only' }
	if (!Array.isArray(value.arguments) || value.arguments.length === 0 || value.arguments.some(argument => !literal_argument(argument))) {
		return { valid: false, error: 'read-only recipe arguments must be non-empty literal strings' }
	}
	if (!['fixture', 'live-provider'].includes(value.validation)) return { valid: false, error: 'read-only recipe validation must be fixture or live-provider' }
	return {
		valid: true,
		recipe: {
			schema_version: 1,
			provider: value.provider,
			source_access: 'read-only',
			arguments: [...value.arguments],
			validation: value.validation,
		},
	}
}

const find_arguments = (command, expected) => {
	if (!Array.isArray(command) || !command.every(literal_argument)) return -1
	for (let index = 0; index <= command.length - expected.length; index += 1) {
		if (expected.every((argument, offset) => command[index + offset] === argument)) return index
	}
	return -1
}

const create_dispatch_proof = (recipe_value, command) => {
	const checked = validate_recipe(recipe_value)
	if (!checked.valid) return checked
	const command_index = find_arguments(command, checked.recipe.arguments)
	if (command_index < 0) return { valid: false, error: 'read-only recipe arguments were not applied to the literal dispatch command' }
	return {
		valid: true,
		proof: {
			schema_version: 1,
			kind: 'provider-recipe-dispatch',
			provider: checked.recipe.provider,
			source_access: 'read-only',
			applied_arguments: [...checked.recipe.arguments],
			command_index,
			recipe_digest: digest(checked.recipe),
			validation: checked.recipe.validation,
			os_confinement: 'not-proven',
			network_isolation: 'not-proven',
			credential_isolation: 'not-proven',
		},
	}
}

const validate_dispatch_proof = value => {
	if (!is_object(value)) return { valid: false, error: 'read-only dispatch proof must be an object' }
	if (Object.keys(value).some(key => !proof_fields.includes(key))) return { valid: false, error: 'read-only dispatch proof contains an unknown field' }
	if (value.schema_version !== 1 || value.kind !== 'provider-recipe-dispatch') return { valid: false, error: 'read-only dispatch proof version or kind is invalid' }
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.provider || '') || value.source_access !== 'read-only') return { valid: false, error: 'read-only dispatch proof provider or source_access is invalid' }
	if (!Array.isArray(value.applied_arguments) || value.applied_arguments.length === 0 || value.applied_arguments.some(argument => !literal_argument(argument))) return { valid: false, error: 'read-only dispatch proof requires literal applied arguments' }
	if (!Number.isInteger(value.command_index) || value.command_index < 0) return { valid: false, error: 'read-only dispatch proof command_index is invalid' }
	if (!/^[0-9a-f]{64}$/u.test(value.recipe_digest || '')) return { valid: false, error: 'read-only dispatch proof recipe_digest is invalid' }
	if (!['fixture', 'live-provider'].includes(value.validation)) return { valid: false, error: 'read-only dispatch proof validation is invalid' }
	for (const field of ['os_confinement', 'network_isolation', 'credential_isolation']) {
		if (value[field] !== 'not-proven') return { valid: false, error: `read-only dispatch proof ${field} must remain not-proven` }
	}
	return { valid: true, proof: JSON.parse(JSON.stringify(value)) }
}

module.exports = {
	recipe_fields,
	proof_fields,
	validate_recipe,
	create_dispatch_proof,
	validate_dispatch_proof,
}
