import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api } from '../api.js'
import ModelPicker, { preferredModel } from './ModelPicker.jsx'

function MessageParts({ message }) {
  return message.content.map((part, i) => {
    if (part.text) {
      return (
        <div key={i} className="markdown chat-md">
          <ReactMarkdown>{part.text}</ReactMarkdown>
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
    try {
      await api.streamChat(tripId, text, {
        model,
        onEvent: (event, data) => {
          if (event === 'text') setStreamText((prev) => (prev ?? '') + data.text)
          else if (event === 'trip') onTripChanged()
          else if (event === 'error') setError(data.error)
        },
      })
      const chat = await api.getChat(tripId)
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
    <section className="chat-panel" aria-label="Trip assistant">
      <div className="chat-header">
        <h2 className="chat-title">Assistant</h2>
        <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />
      </div>
      <div className="chat-history" ref={scrollRef}>
        {messages === null ? (
          <p className="muted">Loading conversation…</p>
        ) : messages.length === 0 && !pendingUser && !busy ? (
          <p className="muted chat-empty">
            Ask the assistant to plan or change this trip — e.g. “Add a relaxed food-focused day in
            Florence on the 12th.”
          </p>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="chat-user">
                {m.content.map((p) => p.text ?? '').join('')}
              </div>
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
                <ReactMarkdown>{streamText}</ReactMarkdown>
              </div>
            )}
            <div className="chat-dots" role="status" aria-label="The assistant is working">
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
          aria-label="Message the assistant"
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
