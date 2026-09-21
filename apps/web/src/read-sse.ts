export type ServerSentEvent = {
  data: string
  event: string
}

function parseEvent(block: string): ServerSentEvent | undefined {
  let event = 'message'
  const data: string[] = []

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')

    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }

  return data.length === 0 ? undefined : { data: data.join('\n'), event }
}

export async function readSse(
  response: Response,
  onEvent: (event: ServerSentEvent) => Promise<void> | void,
) {
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Request failed with status ${response.status}`)
  }
  if (!response.body) throw new Error('Streaming response body is unavailable')

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''

  const drain = async (flush = false) => {
    buffer = buffer.replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')

    while (boundary !== -1) {
      const event = parseEvent(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (event) await onEvent(event)
      boundary = buffer.indexOf('\n\n')
    }

    if (flush && buffer.length > 0) {
      const event = parseEvent(buffer)
      buffer = ''
      if (event) await onEvent(event)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    await drain()
  }

  buffer += decoder.decode()
  await drain(true)
}
