import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from './ExternalLink';

/** Text of a markdown node's children (a link's label); non-text children are dropped. */
const textOf = (children: unknown): string => (Array.isArray(children) ? children.map(textOf).join('') : typeof children === 'string' ? children : '');

/**
 * The question a run's own agent asked (the run record's `finalText`), as light markdown: no images and no raw HTML,
 * and a link only for an http(s) address, through ExternalLink; any other link shows as its label. Never for tracker
 * comments: those are anyone's text and stay plain.
 */
export function AgentQuestion({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img']}
        unwrapDisallowed={false}
        components={{
          a: ({ href, children: label }) => {
            const text = textOf(label) || (href ?? '');
            return href !== undefined && /^https?:\/\//i.test(href) ? <ExternalLink href={href}>{text}</ExternalLink> : <span>{text}</span>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
