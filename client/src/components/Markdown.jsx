import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Shared markdown renderer: GFM autolinks bare URLs (https://example.com
// becomes clickable without [] syntax), and all links open in a new tab so
// following one never loses the itinerary page.
export default function Markdown({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
