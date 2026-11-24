import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

type User = { id: string; email: string; name: string; groups: string[]; credits: number }

const users = new Map<string, User>([
  ['x@y.com', { id: 'u1', email: 'x@y.com', name: 'X', groups: [], credits: 0 }]
])

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }
  ]
})

function byId(id: string): User | undefined {
  return [...users.values()].find((user) => user.id === id)
}

function withUser(id: string, apply: (user: User) => void) {
  const user = byId(id)
  if (!user) {
    return { ...text(`no user ${id}`), isError: true }
  }
  apply(user)
  return text(user)
}

const server = new McpServer({ name: 'fake-crm', version: '1.0.0' })

server.registerTool(
  'find_user',
  { description: 'Find a user by email', inputSchema: { email: z.string() } },
  async ({ email }) => {
    const user = users.get(email)
    return user ? text(user) : { ...text(`no user ${email}`), isError: true }
  }
)
server.registerTool(
  'update_user',
  { description: 'Rename a user', inputSchema: { user_id: z.string(), name: z.string() } },
  async ({ user_id, name }) =>
    withUser(user_id, (user) => {
      user.name = name
    })
)
server.registerTool(
  'add_to_group',
  { description: 'Add a user to a group', inputSchema: { user_id: z.string(), group: z.string() } },
  async ({ user_id, group }) =>
    withUser(user_id, (user) => {
      user.groups.push(group)
    })
)
server.registerTool(
  'add_credits',
  {
    description: 'Add credits to a user',
    inputSchema: { user_id: z.string(), amount: z.number() }
  },
  async ({ user_id, amount }) =>
    withUser(user_id, (user) => {
      user.credits += amount
    })
)
server.registerTool('get_state', { description: 'All users' }, async () =>
  text([...users.values()])
)
server.registerTool('crash', { description: 'Exit with an error' }, async () => {
  process.stderr.write('boom\n', () => process.exit(1))
  return new Promise<never>(() => {})
})
server.registerTool('big', { description: 'Return 5 MB of text' }, async () =>
  text('x'.repeat(5 * 1024 * 1024))
)

void server.connect(new StdioServerTransport())
