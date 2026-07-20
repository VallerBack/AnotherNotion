import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ children, empty = '暂无说明' }: { children: string; empty?: string }) {
  if (!children.trim()) return <p className="muted">{empty}</p>
  return <div className="markdown-rendered"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    components={{
      a: ({ node, ...props }) => { void node; return <a {...props} target="_blank" rel="noopener noreferrer" /> },
    }}
  >{children}</ReactMarkdown></div>
}
