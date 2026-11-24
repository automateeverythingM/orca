type ContentFields = Record<string, unknown>

function isContentFields(value: unknown): value is ContentFields {
  return typeof value === 'object' && value !== null
}

const contentFields = (value: unknown): ContentFields => (isContentFields(value) ? value : {})

function describeBinary(kind: string, item: ContentFields): string {
  const mime = typeof item.mimeType === 'string' ? item.mimeType : 'unknown'
  const data = typeof item.data === 'string' ? item.data : ''
  return `[${kind} ${mime} ${Math.floor((data.length * 3) / 4)} bytes]`
}

export function renderMcpContent(content: unknown[]): string {
  return content
    .map((raw) => {
      const item = contentFields(raw)
      switch (item.type) {
        case 'text':
          return typeof item.text === 'string' ? item.text : ''
        case 'image':
        case 'audio':
          return describeBinary(item.type, item)
        case 'resource': {
          const resource = contentFields(item.resource)
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
