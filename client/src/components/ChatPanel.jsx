import { Fragment, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import Markdown from './Markdown.jsx'
import ModelPicker, { preferredModel } from './ModelPicker.jsx'

// Streamed replies are stored as many small text chunks. Rendering each chunk
// as its own markdown block inserts fake paragraph breaks at chunk boundaries
// (and a chunk that happens to start with "1234)" turns into an ordered list),
// so adjacent text parts are joined back into one string first — chunks are
// deltas of one continuous reply, so plain concatenation is lossless.
function coalesceTextParts(content) {
  const merged = []
  for (const part of content) {
    const prev = merged[merged.length - 1]
    if (typeof part.text === 'string' && prev && typeof prev.text === 'string') {
      merged[merged.length - 1] = { text: prev.text + part.text }
    } else {
      merged.push(part)
    }
  }
  return merged
}

function MessageParts({ message }) {
  return coalesceTextParts(message.content).map((part, i) => {
    if (part.text) {
      return (
        <div key={i} className="markdown chat-md">
          <Markdown>{part.text}</Markdown>
        </div>
      )
    }
    if (part.toolRequest?.name === 'updateItinerary') {
      const days = part.toolRequest.input?.days ?? []
      return (
        <div key={i} className="chat-tool-card">
          <span className="chat-tool-title">✦ Itinerary updated</span>
          {days.length > 0 && (
            <ul>
              {days.map((d) => (
                <li key={d.date}>
                  <strong>{d.date}</strong>
                  {d.title ? ` — ${d.title}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }
    return null
  })
}

export default function ChatPanel({
  tripId,
  models,
  initialPrompt,
  initialModel,
  onTripChanged,
  onBusyChange,
}) {
  const [messages, setMessages] = useState(null)
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState(initialModel || preferredModel(models))
  const [streamText, setStreamText] = useState(null) // null = idle
  // True when a response started elsewhere (e.g. before navigating away) is
  // still being generated server-side; we show progress and poll for it.
  const [remotePending, setRemotePending] = useState(false)
  const [pendingUser, setPendingUser] = useState(null)
  const [error, setError] = useState('')
  const sentInitial = useRef(false)
  const scrollRef = useRef(null)
  const busy = streamText !== null || remotePending

  useEffect(() => {
    api
      .getChat(tripId)
      .then((c) => {
        setMessages(c.messages)
        setRemotePending(Boolean(c.pending))
      })
      .catch((err) => setError(err.message))
  }, [tripId])

  useEffect(() => {
    if (!remotePending) return undefined
    onBusyChange?.(true)
    const poll = setInterval(async () => {
      try {
        const c = await api.getChat(tripId)
        if (!c.pending) {
          setMessages(c.messages)
          setRemotePending(false)
          onBusyChange?.(false)
          onTripChanged()
        }
      } catch {
        // transient poll failures are fine; the next tick retries
      }
    }, 2000)
    return () => clearInterval(poll)
  }, [remotePending, tripId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (messages && messages.length === 0 && !remotePending && initialPrompt && !sentInitial.current) {
      sentInitial.current = true
      send(initialPrompt)
    }
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, streamText, pendingUser, remotePending])

  async function send(text) {
    setError('')
    setPendingUser(text)
    setStreamText('')
    onBusyChange?.(true)
    // The server can rename the trip's slug mid-conversation (first naming);
    // the final trip event carries the new id, and the post-stream history
    // reload must use it — the old id's files have moved.
    let liveTripId = tripId
    try {
      await api.streamChat(tripId, text, {
        model,
        onEvent: (event, data) => {
          if (event === 'text') setStreamText((prev) => (prev ?? '') + data.text)
          else if (event === 'trip') {
            if (data?.id) liveTripId = data.id
            onTripChanged(data)
          } else if (event === 'error') {
            setError(data.error)
            setDraft(text) // put the message back so the user can retry or copy it
          }
        },
      })
      const chat = await api.getChat(liveTripId)
      setMessages(chat.messages)
    } catch (err) {
      setError(err.message)
      setDraft(text) // let the user retry
    } finally {
      setPendingUser(null)
      setStreamText(null)
      onBusyChange?.(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    send(text)
  }

  return (
    <section className="chat-panel" aria-label="Travel agent">
      <div className="chat-header">
        <h2 className="chat-title">Travel Agent</h2>
      </div>
      {models.length > 1 && (
        <div className="chat-toolbar">
          <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />
        </div>
      )}
      <div className="chat-history" ref={scrollRef}>
        {messages === null ? (
          <p className="muted">Loading conversation…</p>
        ) : messages.length === 0 && !pendingUser && !busy ? (
          <p className="muted chat-empty">
            Ask the travel agent to plan or change this trip — e.g. “Add a relaxed food-focused day
            in Florence on the 12th.”
          </p>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <Fragment key={i}>
                <div className={`chat-user${m.failed ? ' chat-user-failed' : ''}`}>
                  {m.content.map((p) => p.text ?? '').join('')}
                </div>
                {m.failed && (
                  <div className="chat-failed-note">Not sent — this request failed. Copy it or send it again.</div>
                )}
              </Fragment>
            ) : m.role === 'model' ? (
              <div key={i} className="chat-agent">
                <MessageParts message={m} />
              </div>
            ) : null
          )
        )}
        {pendingUser && <div className="chat-user">{pendingUser}</div>}
        {busy && (
          <div className="chat-agent">
            {streamText && (
              <div className="markdown chat-md">
                <Markdown>{streamText}</Markdown>
              </div>
            )}
            <div className="chat-dots" role="status" aria-label="The travel agent is working">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
          placeholder="Ask for changes, e.g. “Let’s have day 2 end at 3pm”"
          aria-label="Message the travel agent"
          rows={2}
          disabled={busy}
        />
        <button
          type="submit"
          className="btn btn-primary btn-small"
          disabled={!draft.trim() || busy}
        >
          Send
        </button>
      </form>
    </section>
  )
}
