// Runs inside QuickJS before agent code; captures and hides the raw host bindings.
export const CODEMODE_PRELUDE = String.raw`(() => {
  const host = globalThis.__host
  const emit = globalThis.__print
  delete globalThis.__host
  delete globalThis.__print

  const send = async (tool, input) => JSON.parse(await host(tool, JSON.stringify(input ?? null)))
  const call = async (tool, input) => {
    const reply = await send(tool, input)
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  }
  const withKey = (key) => (arg) => (typeof arg === 'string' ? { [key]: arg } : arg)
  const pathArg = withKey('path')
  const patternArg = withKey('pattern')

  const serverTools = (server) =>
    new Proxy({}, {
      get: (_target, tool) =>
        typeof tool === 'string' && tool !== 'then'
          ? (args) => call('mcp.call', { server, tool, args: args ?? {} })
          : undefined
    })
  const reserved = {
    list: () => call('mcp.list', {}),
    describe: (server) => call('mcp.describe', { server }),
    call: (server, tool, args) => call('mcp.call', { server, tool, args: args ?? {} })
  }
  globalThis.mcp = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined
      return Object.hasOwn(reserved, name) ? reserved[name] : serverTools(name)
    }
  })

  globalThis.read = (arg) => call('read', pathArg(arg))
  globalThis.write = (arg) => call('write', arg)
  globalThis.edit = (arg) => call('edit', arg)
  globalThis.grep = (arg) => call('grep', patternArg(arg))
  globalThis.find = (arg) => call('find', patternArg(arg))
  // bash reports failures as output so scripts can branch on exit_code.
  globalThis.bash = async (cmd, options) => {
    const reply = await send('bash', { ...options, cmd })
    return reply.ok ? reply.value : { exit_code: 126, output: reply.error }
  }

  const show = (value) => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.name + ': ' + value.message
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  globalThis.print = (...values) => emit(values.map(show).join(' '))
})()
`
