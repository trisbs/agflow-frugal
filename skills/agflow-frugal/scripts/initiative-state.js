'use strict'

const fs = require('node:fs')
const path = require('node:path')

const state_line = (text, label, allow_history = false) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*[-*+]\\s+\\*\\*${escaped}:\\*\\*\\s*(approved|pending);\\s*(active|blocked|complete);\\s*current=(T-\\d+)\\.?\\s*$`, 'gimu')
  const matches = [...String(text || '').matchAll(pattern)]
  if (matches.length === 0 || (!allow_history && matches.length !== 1)) return null
  const last = matches.at(-1)
  return { approval: last[1].toLowerCase(), state: last[2].toLowerCase(), current: last[3].toUpperCase() }
}

const field = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*[-*+]\\s+\\*\\*${escaped}:\\*\\*\\s*(.*?)\\.?\\s*$`, 'imu').exec(String(text || ''))?.[1]?.trim()
}

const validate_records = ({ task_text, plan_text, tracker_text, notebook_text }) => {
  const errors = []
  const task = state_line(task_text, 'Agentflow state')
  const plan = state_line(plan_text, 'Agentflow state')
  const notebook = state_line(notebook_text, 'Initiative state', true)
  const tracker = {
    approval: field(tracker_text, 'Plan approval')?.toLowerCase(),
    state: field(tracker_text, 'State')?.toLowerCase(),
    current: field(tracker_text, 'Current item')?.toUpperCase(),
    ask: field(tracker_text, 'Active Ask')?.toUpperCase(),
  }
  for (const [name, record] of [['Task.md', task], ['plan', plan], ['tracker', tracker], ['active notebook', notebook]]) {
    if (!record || !record.approval || !record.state || !record.current) errors.push(`${name} is missing its approval, state, or current-task marker`)
  }
  if (errors.length) return { status: 'fail', errors }

  for (const [field_name, pretty] of [['approval', 'approval'], ['state', 'workflow state'], ['current', 'current task']]) {
    const values = [['Task.md', task[field_name]], ['plan', plan[field_name]], ['tracker', tracker[field_name]], ['active notebook', notebook[field_name]]]
    const expected = values[0][1]
    for (const [name, value] of values.slice(1)) {
      if (value !== expected) errors.push(`${name} ${pretty} ${value} disagrees with Task.md ${pretty} ${expected}`)
    }
  }

  const ask_heading = new RegExp(`^# → Ask / ${tracker.ask}(?:\\s|$)`, 'mu')
  if (!tracker.ask || !ask_heading.test(String(notebook_text || ''))) errors.push(`active notebook does not contain the tracker Ask ${tracker.ask || '(missing)'}`)
  const checklist = new RegExp(`^[-*+] \\[([ xX])\\] \\*\\*${tracker.current}:\\*\\*`, 'mu').exec(String(tracker_text || ''))
  if (!checklist) errors.push(`tracker has no checklist item for current task ${tracker.current}`)
  else if (checklist[1].toLowerCase() === 'x') errors.push(`tracker current task ${tracker.current} is marked complete`)

  return { status: errors.length ? 'fail' : 'pass', errors }
}

const linked_path = (tracker_text, name) => field(tracker_text, name)

const validate_linked_files = ({ repo, tracker_text }) => {
  const names = ['Task file', 'Plan file', 'Notebook file']
  const values = Object.fromEntries(names.map(name => [name, linked_path(tracker_text, name)]))
  if (Object.values(values).every(value => !value)) return null
  const contents = {}
  const errors = []
  const repo_real = fs.realpathSync(path.resolve(repo))
  for (const name of names) {
    const relative = values[name]
    if (!relative) { errors.push(`tracker is missing linked ${name.toLowerCase()} path`); continue }
    const absolute = path.resolve(repo_real, relative)
    const inside = path.relative(repo_real, absolute)
    if (inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) {
      errors.push(`linked ${name.toLowerCase()} path escapes the repository`)
      continue
    }
    try {
      const real = fs.realpathSync(absolute)
      const real_inside = path.relative(repo_real, real)
      if (real_inside.startsWith(`..${path.sep}`) || real_inside === '..' || path.isAbsolute(real_inside)) {
        errors.push(`linked ${name.toLowerCase()} path escapes the repository through a symbolic link`)
        continue
      }
      const stat = fs.lstatSync(absolute)
      if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`linked ${name.toLowerCase()} is not a regular file`); continue }
      contents[name] = fs.readFileSync(absolute, 'utf8')
    } catch {
      errors.push(`linked ${name.toLowerCase()} is missing or unreadable`)
    }
  }
  if (errors.length) return { status: 'fail', errors }
  const result = validate_records({
    task_text: contents['Task file'],
    plan_text: contents['Plan file'],
    tracker_text,
    notebook_text: contents['Notebook file'],
  })
  return result
}

module.exports = { validate_records, validate_linked_files }
