export type CodemodeToolInfo = { name: string; description?: string; input_schema: unknown }

/** `structured` is the tool's `structuredContent` when it sent one; `text` is the rendered content. */
export type CodemodeToolResult = { text: string; structured?: unknown }

/** Connectors by name, read live so a switch applies to the next call. */
export type CodemodeConnectorAccess = {
  /** Every connector's name, usable or not: a local server of that name never runs. */
  claimed(): string[]
  /** Id of the connector claiming `name`, usable or not; null when none does. */
  idOf(name: string): string | null
  /** The connectors this chat may call now. */
  names(): string[]
  describe(name: string, signal?: AbortSignal): Promise<CodemodeToolInfo[]>
  call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CodemodeToolResult>
}

/** Identity prefix of a server name served by a connector; a local one is `local:<name>`. */
export const CONNECTOR_IDENTITY = 'connector:'

export function isConnectorIdentity(identity: string): boolean {
  return identity.startsWith(CONNECTOR_IDENTITY)
}
