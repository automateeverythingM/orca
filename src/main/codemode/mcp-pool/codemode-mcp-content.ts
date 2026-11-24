function describeBinary(kind: string, item: Record<string, unknown>): string {
  const mime = typeof item.mimeType === 'string' ? item.mimeType : 'unknown'
  const data = typeof item.data === 'string' ? item.data : ''
  return `[${kind} ${mime} ${Math.floor((data.length * 3) / 4)} bytes]`
}

export function renderMcpContent(content: unknown[]): string {
  return content
    .map((raw) => {
      const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      switch (item.type) {
        case 'text':
          return typeof item.text === 'string' ? item.text : ''
        case 'image':
        case 'audio':
          return describeBinary(item.type, item)
        case 'resource': {
          const resource = (item.resource ?? {}) as Record<string, unknown>
          if (typeof resource.text === 'string') {
            return resource.text
          }
          const blob = typeof resource.blob === 'string' ? resource.blob : ''
          const mime = typeof resource.mimeType === 'string' ? resource.mimeType : 'unknown'
          return `[resource ${String(resource.uri ?? '')} ${mime} ${Math.floor((blob.length * 3) / 4)} bytes]`
        }
        case 'resource_link':
          return `[resource ${String(item.uri ?? '')}]`
        default:
          return `[${String(item.type ?? 'unknown')} content]`
      }
    })
    .join('\n')
}
