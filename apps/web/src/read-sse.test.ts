import { describe, expect, it, vi } from 'vitest'

import { readSse } from './read-sse.js'

function streamingResponse(chunks: string[]) {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  )
}

describe('readSse', () => {
  it('parses events split across chunks with CRLF and LF boundaries', async () => {
    const onEvent = vi.fn()
    const response = streamingResponse([
      'event: text_',
      'delta\r\ndata: {"delta":"A"}\r\n\r',
      '\nevent: complete\ndata: {"stopReason":"aborted"}\n\n',
    ])

    await readSse(response, onEvent)

    expect(onEvent.mock.calls).toEqual([
      [{ event: 'text_delta', data: '{"delta":"A"}' }],
      [{ event: 'complete', data: '{"stopReason":"aborted"}' }],
    ])
  })

  it('parses multiple events and a final event without a blank line', async () => {
    const events: Array<{ event: string; data: string }> = []

    await readSse(
      streamingResponse([
        'event: text_delta\ndata: first\n\nevent: text_delta\ndata: second\n\n',
        'event: error\ndata: failed',
      ]),
      (event) => {
        events.push(event)
      },
    )

    expect(events).toEqual([
      { event: 'text_delta', data: 'first' },
      { event: 'text_delta', data: 'second' },
      { event: 'error', data: 'failed' },
    ])
  })

  it('reports JSON errors from non-streaming responses', async () => {
    const response = new Response(JSON.stringify({ error: 'Invalid prompt request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })

    await expect(readSse(response, vi.fn())).rejects.toThrow('Invalid prompt request')
  })
})
