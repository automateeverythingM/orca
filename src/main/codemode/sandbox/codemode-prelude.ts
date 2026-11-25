// Runs inside QuickJS before agent code; hides the raw host bindings and evaluates to the thrown-value reader.
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

  // orca.worktree.create(p) calls orca.call('worktree.create', p); JS protocol names stay unset so
  // awaiting, printing or serializing a path never fires a call.
  const notMethods = new Set(['then', 'toJSON', 'valueOf', 'constructor'])
  const orcaPath = (method) =>
    new Proxy(() => {}, {
      get: (_target, key) => {
        if (typeof key !== 'string' || notMethods.has(key)) return undefined
        if (key === 'toString') return () => '[orca ' + method + ']'
        return orcaPath(method + '.' + key)
      },
      apply: (_target, _this, args) => call('orca.call', { method, params: args[0] })
    })
  const orcaReserved = {
    areas: () => call('orca.areas', {}),
    describe: (target) => call('orca.describe', { target }),
    context: () => call('orca.context', {}),
    call: (method, params) => call('orca.call', { method, params })
  }
  globalThis.orca = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string' || notMethods.has(name)) return undefined
      // Like a chained path: printing or stringifying orca itself must not call the host.
      if (name === 'toString') return () => '[orca]'
      return Object.hasOwn(orcaReserved, name) ? orcaReserved[name] : orcaPath(name)
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

  // Captured before agent code runs; reads data properties only so thrown getters and toJSON never run.
  const ownDescriptor = Object.getOwnPropertyDescriptor
  const prototypeOf = Object.getPrototypeOf
  const hasOwn = Object.hasOwn
  const quote = JSON.stringify
  const toText = String
  const dataString = (target, key) => {
    for (let at = target, depth = 0; at !== null && depth < 16; at = prototypeOf(at), depth++) {
      const descriptor = ownDescriptor(at, key)
      if (descriptor) {
        return hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : null
      }
    }
    return null
  }
  const field = (value) => (value === null ? 'null' : quote(value))
  return (thrown) => {
    if (thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')) {
      return '{"text":' + quote(toText(thrown)) + '}'
    }
    const name = field(dataString(thrown, 'name'))
    const message = field(dataString(thrown, 'message'))
    const stack = field(dataString(thrown, 'stack'))
    return '{"name":' + name + ',"message":' + message + ',"stack":' + stack + '}'
  }
})()
`
