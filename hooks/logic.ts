/** What a Bash command segment does that dev-flow gates. */
export type Hit = {
  kind: 'commit' | 'push' | 'mr' | 'cargo' | 'delete-branch' | 'new-branch'
  /** new-branch only: the branch being created. */
  branch?: string
  /** new-branch only: the explicit base, if the command named one. */
  base?: string
}

// ponytail: segments split on shell separators, so a separator inside a quoted
// string (a commit message) can fake a segment start. Upgrade to a real parser if it bites.
const SEPARATORS = /&&|\|\||[;|\n]/

const PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?`
const git = (sub: string) => new RegExp(`${PREFIX}git(?:\\s+-C\\s+\\S+)?\\s+${sub}`)

const COMMIT = git(String.raw`commit\b`)
const PUSH = git(String.raw`push\b`)
const DELETE_BRANCH = git(String.raw`branch\b(?=.*\s(?:-d|-D|--delete)\b)`)
const NEW_BRANCH = git(String.raw`(?:checkout|switch)\s+(?:-b|-B|-c|-C)\s+(\S+)(?:\s+(\S+))?`)
const NEW_BRANCH_PLAIN = git(String.raw`branch\s+([^-\s]\S*)(?:\s+(\S+))?\s*$`)
const MR = new RegExp(`${PREFIX}(?:glab\\s+mr|gh\\s+pr)\\s+create\\b`)
const CARGO = new RegExp(`${PREFIX}cargo\\b`)

/**
 * Finds the gated actions in a shell command.
 *
 * @param command the Bash tool's command string
 * @returns one Hit per gated segment, in order; a cargo run inside `docker ...` is not a hit
 */
export function classify(command: string): Hit[] {
  const hits: Hit[] = []

  for (const raw of command.split(SEPARATORS)) {
    const s = raw.trim()
    const created = NEW_BRANCH.exec(s) ?? NEW_BRANCH_PLAIN.exec(s)

    if (COMMIT.test(s)) hits.push({ kind: 'commit' })
    else if (PUSH.test(s)) hits.push({ kind: 'push' })
    else if (MR.test(s)) hits.push({ kind: 'mr' })
    else if (CARGO.test(s)) hits.push({ kind: 'cargo' })
    else if (DELETE_BRANCH.test(s)) hits.push({ kind: 'delete-branch' })
    else if (created) hits.push({ kind: 'new-branch', branch: created[1], base: created[2] })
  }

  return hits
}

/**
 * Whether the user really said `quote` in their last message.
 *
 * @param last the user's last prompt
 * @param quote the exact words the model claims approved the action
 * @returns true when `quote` (2+ chars) appears in `last`, ignoring case and whitespace runs
 */
export function said(last: string, quote: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim()
  const q = norm(quote)

  return q.length >= 2 && norm(last).includes(q)
}
