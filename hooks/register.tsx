/** dev-flow: stage status line, approval gates, stacked-branch and cargo guards, merge poll. */
import type { EngineInterface, Register } from 'claude-code'

import { classify, said } from './logic'

type Mode = 'coding' | 'planning'

type State = {
  mode: Mode
  /** Titles root to leaf (coding), or the single planning label. */
  chain: string[]
  ticket?: number
  /** Index into STAGES[mode]. */
  stage: number
  baseBranch?: string
  /** Open stacked branches, oldest first. */
  stack: string[]
  /** Branches seen merged, cleanup pending. */
  merged: string[]
  /** action -> remaining uses. */
  approved: Record<string, number>
  lastPrompt: string
}

const STAGES: Record<Mode, string[]> = {
  coding: [
    'Code',
    'Check',
    'Review',
    'Fix Review Comments',
    'Second Review',
    'Commit Plan',
    'Commit/Push/MR',
    'Redmine Update',
    'Plan Doc Update',
  ],
  planning: ['Research', 'Draft Plan', 'Review Plan', 'Fix Review Comments', 'Create Tickets'],
}

const ACTIONS = ['commit', 'push', 'mr', 'cargo', 'delete-branch', 'close-ticket']
const POLL_MS = 60 * 60 * 1000

const fresh = (): State => ({
  mode: 'coding',
  chain: [],
  stage: 0,
  stack: [],
  merged: [],
  approved: {},
  lastPrompt: '',
})

const stageName = (s: State) => STAGES[s.mode][s.stage]

const statePath = async ($: EngineInterface) => `${await $.session.cwd()}/tmp/dev-flow.json`

const load = async ($: EngineInterface): Promise<State> => {
  try {
    return { ...fresh(), ...JSON.parse(await $.fs.read(await statePath($))) }
  } catch {
    return fresh()
  }
}

/** The band text, or undefined when no flow is set. */
const line = (s: State) => {
  if (!s.chain.length && !s.merged.length) return undefined

  const path = [...(s.mode === 'planning' ? ['Planning'] : []), ...s.chain, stageName(s)].join(' › ')

  return s.merged.length ? `${path} | merged: ${s.merged.join(', ')}` : path
}

/** The text lives in the band above the prompt: clear the old status entry and redraw it. */
const show = ($: EngineInterface, _s: State) => {
  $.ui.status(undefined)
  $.ui.invalidate('ui.render')
}

const save = async ($: EngineInterface, s: State) => {
  await $.fs.write(await statePath($), JSON.stringify(s, null, 2))
  show($, s)
}

const block = ($: EngineInterface, why: string) => {
  $.ui.toast(`dev-flow: ${why}`)

  return { deny: `dev-flow: ${why}` }
}

/** Spends one use of an approval; false when none is left. */
const take = (s: State, action: string) => {
  const n = s.approved[action] ?? 0

  if (n < 1) return false

  s.approved[action] = n - 1

  return true
}

const needs = (action: string, ask: string) =>
  `${action} needs the user's approval. Ask "${ask}", wait for the yes, then call mcp__dev-flow__approve with their exact words.`

/** The reason a gated Bash action is refused, or undefined when it may run. */
const check = async ($: EngineInterface, s: State, hit: ReturnType<typeof classify>[number]) => {
  switch (hit.kind) {
    case 'commit': {
      if (s.mode === 'coding' && s.stage < STAGES.coding.indexOf('Commit Plan')) {
        return `no commit before the Commit Plan stage (now: ${stageName(s)}). Review and commit-plan approval come first.`
      }

      return take(s, 'commit') ? undefined : needs('commit', 'commit?')
    }
    case 'push':
    case 'mr':
    case 'delete-branch':
    case 'cargo': {
      const ask = { push: 'push?', mr: 'raise the MR?', 'delete-branch': 'delete these branches?', cargo: 'run cargo on the host?' }[hit.kind]

      return take(s, hit.kind) ? undefined : needs(hit.kind, ask)
    }
    case 'new-branch': {
      const allowed = s.stack.at(-1) ?? s.baseBranch

      if (!allowed) return 'base branch unknown. Ask the user which branch (main or develop) is the base, then call mcp__dev-flow__set {baseBranch}.'

      const head = hit.base ?? (await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      const base = head.replace(/^origin\//, '')

      return base === allowed ? undefined : `new branch must be based on ${allowed}, not ${base}.`
    }
  }
}

const rules = (s: State) => {
  const lines = [
    'dev-flow mod is active; hooks enforce these rules.',
    `- Status line: feature › step › task › stage. Coding stages: ${STAGES.coding.join(', ')}. Planning stages: ${STAGES.planning.join(', ')}.`,
    '- "start #id": read the Redmine ticket and its parents, then call mcp__dev-flow__set {mode:"coding", ticket, chain:[titles root to leaf]}. No ticket (planning): set {mode:"planning", chain:["<label>"]}.',
    '- Only the user moves a stage. Ask, wait for approval, then call mcp__dev-flow__advance {quote} with the user\'s exact words (optional `to` stage name, e.g. skip Second Review).',
    '- Research and planning: ask one clarifying question at a time. No suggestions, no writes, until the user says go ahead.',
    '- Approval covers exactly what you asked. "commit?" yes unlocks commit only; "commit and push?" yes unlocks both. Call mcp__dev-flow__approve {actions, quote, counts}; counts.commit = commits in the approved commit plan. A commit outside the plan asks again.',
    '- cargo only through docker compose; host cargo needs approve ["cargo"].',
    '- Redmine In Progress needs due_date and estimated_hours: ask the user first, with your suggestion.',
    '- New branch must be based on the previous stacked branch (state `stack`), else baseBranch. Unknown base: ask the user, then set {baseBranch}.',
    '- Check stage: code docs per docs/skills/*.md (not found: ask the user). Every public method documents what it does, param types and meaning, return type and meaning; every file/class has a doc line. Fix before review. Advance past Check only with docsOk:true.',
  ]

  if (s.merged.length) {
    lines.push(
      `- MERGED, cleanup pending: ${s.merged.join(', ')}. Ask with AskUserQuestion multiSelect checklists, each action separate, tickets as "#id title": close child tickets at 100% (never parents; approve ["close-ticket"]), update docs/plans/tickets if the implementation differed, delete merged local branches (approve ["delete-branch"]), mark step/phase complete in its doc and commit, archive a completed step plan to docs/plans/archive/ and mark the step complete in the high-level plan. Then set {merged:[], stack:[remaining]}.`,
    )
  }

  return lines.join('\n')
}

/** Asks glab which stacked branches have a merged MR; records and announces new ones. */
const pollMerged = async ($: EngineInterface) => {
  const s = await load($)
  const open = s.stack.filter(b => !s.merged.includes(b))

  for (const b of open) {
    const { exitCode, stdout } = await $.process.run(['glab', 'mr', 'list', '--merged', '--source-branch', b]).catch(() => ({ exitCode: 1, stdout: '' }))

    if (exitCode === 0 && /^!\d+/m.test(stdout)) {
      s.merged.push(b)
      $.ui.toast(`dev-flow: ${b} merged. Cleanup pending.`)
    }
  }

  await save($, s)
}

type Args = {
  mode?: Mode
  chain?: string[]
  ticket?: number
  baseBranch?: string
  stack?: string[]
  merged?: string[]
  quote?: string
  to?: string
  docsOk?: boolean
  actions?: string[]
  counts?: Record<string, number>
}

/** `.catch` for every gating hook: refuse unless the hook already called `next`. */
const failClosed = ($: EngineInterface, e: any, next: any) => (next.called ? next(e) : { deny: 'dev-flow: guard failed' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const str = { type: 'string' }
    const obj = (properties: object, required: string[] = []) => ({ type: 'object', properties, required })

    await $.tool.register({
      name: 'set',
      description:
        'dev-flow: set the workflow context. mode+chain starts a new flow at its first stage. baseBranch, stack (open stacked branches), merged (pending cleanup) update in place.',
      isDeferred: false,
      inputSchema: obj({
        mode: { enum: ['coding', 'planning'] },
        chain: { type: 'array', items: str },
        ticket: { type: 'integer' },
        baseBranch: str,
        stack: { type: 'array', items: str },
        merged: { type: 'array', items: str },
      }),
    })
    await $.tool.register({
      name: 'advance',
      description: "dev-flow: move to the next stage (or `to`). Only after the user approved; `quote` is their exact words from their last message.",
      isDeferred: false,
      inputSchema: obj({ quote: str, to: str, docsOk: { type: 'boolean' } }, ['quote']),
    })
    await $.tool.register({
      name: 'approve',
      description: `dev-flow: record the user's approval of exactly the actions you asked about (${ACTIONS.join(', ')}). \`quote\` is their exact words from their last message; counts sets uses per action (default 1, cargo 20).`,
      isDeferred: false,
      inputSchema: obj({ actions: { type: 'array', items: str }, quote: str, counts: { type: 'object' } }, ['actions', 'quote']),
    })

    show($, await load($))
    $.clock.every(POLL_MS, () => void pollMerged($))
    void pollMerged($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = e.props.hasSurvey ? undefined : line(await load($))

    if (!text) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{text}</Text>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    const s = await load($)

    s.lastPrompt = e.text
    await save($, s)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)

    return { sections: [...r.sections, { id: 'dev-flow:rules', text: rules(await load($)), scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__dev-flow__set' }, async ($, e) => {
    const a = e as unknown as Args
    const s = await load($)

    if (a.mode || a.chain) {
      s.mode = a.mode ?? s.mode
      s.chain = a.chain ?? s.chain
      s.ticket = a.ticket
      s.stage = 0
      s.approved = {}
    }
    if (a.baseBranch !== undefined) s.baseBranch = a.baseBranch
    if (a.stack !== undefined) s.stack = a.stack
    if (a.merged !== undefined) s.merged = a.merged

    await save($, s)

    return { result: `ok. stage: ${stageName(s)}` }
  })

  on('tool.call', { tool: 'mcp__dev-flow__advance' }, async ($, e) => {
    const a = e as unknown as Args
    const s = await load($)
    const stages = STAGES[s.mode]
    const to = a.to === undefined ? s.stage + 1 : stages.indexOf(a.to)

    if (!said(s.lastPrompt, a.quote ?? '')) return block($, "quote not found in the user's last message. Ask the user to approve first.")
    if (to < 0 || to >= stages.length) return block($, `no such stage. Stages: ${stages.join(', ')}.`)
    if (stages[s.stage] === 'Check' && to > s.stage && !a.docsOk) {
      return block($, 'Check stage: verify code docs (docs/skills/*.md, else ask the user), fix gaps, then advance with docsOk:true.')
    }

    // ponytail: approvals live until the next advance, except into Commit/Push/MR; stale ones expire there.
    if (stages[to] !== 'Commit/Push/MR') s.approved = {}
    s.stage = to
    await save($, s)

    return { result: `stage: ${stageName(s)}` }
  })

  on('tool.call', { tool: 'mcp__dev-flow__approve' }, async ($, e) => {
    const a = e as unknown as Args
    const s = await load($)
    const bad = (a.actions ?? []).filter(x => !ACTIONS.includes(x))

    // ponytail: the quote proves the user spoke, not what they were asked; the model names the actions.
    if (!said(s.lastPrompt, a.quote ?? '')) return block($, "quote not found in the user's last message. Ask the user to approve first.")
    if (bad.length || !a.actions?.length) return block($, `unknown actions: ${bad.join(', ')}. Valid: ${ACTIONS.join(', ')}.`)

    for (const x of a.actions) s.approved[x] = a.counts?.[x] ?? (x === 'cargo' ? 20 : 1)
    await save($, s)

    return { result: `approved: ${JSON.stringify(s.approved)}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const s = await load($)
    const hits = classify(e.command)

    for (const hit of hits) {
      const why = await check($, s, hit)

      if (why) return block($, why)
    }
    if (!hits.length) return next(e)

    const ran = await next(e)
    const made = hits.find(h => h.kind === 'new-branch')

    if (made?.branch && !ran.deny && !ran.isError) s.stack.push(made.branch)
    await save($, s)

    return ran
  }).catch(failClosed)

  for (const tool of ['Edit', 'Write', 'NotebookEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const s = await load($)

      return s.mode === 'planning' && stageName(s) === 'Research' ? block($, 'Research stage: no writes until the user says go ahead.') : next(e)
    }).catch(failClosed)
  }

  on('tool.call', { tool: 'mcp__redmine__update_redmine_issue' }, async ($, e, next) => {
    const f = ((e as unknown as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>
    const status = String(f.status_name ?? '')

    if (/in progress/i.test(status) && (!f.due_date || !f.estimated_hours)) {
      return block($, 'In Progress needs due_date and estimated_hours. Ask the user for both, with your suggestion.')
    }
    // ponytail: matches status names only; a bare status_id for Closed slips through.
    if (/clos|resolv|done|complete/i.test(status) || f.done_ratio === 100) {
      const s = await load($)

      if (!take(s, 'close-ticket')) return block($, needs('closing the ticket', 'close #id?'))
      await save($, s)
    }

    return next(e)
  }).catch(failClosed)
}
