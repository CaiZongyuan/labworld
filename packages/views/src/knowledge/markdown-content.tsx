import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import {
  AttachmentImage,
  AttachmentLink,
  attachmentId,
} from './attachment-markdown';
import { useAppMessage } from '../shell/messages';

const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'attachment'],
    src: [...(defaultSchema.protocols?.src ?? []), 'attachment'],
  },
};

export default function MarkdownContent({
  markdown,
  framed = true,
}: {
  markdown: string;
  framed?: boolean;
}) {
  const message = useAppMessage('knowledge');
  // Images render the author's alt text, falling back to a localized
  // placeholder in both the attachment channel and the plain-text one.
  const imageAlt = (alt?: string) => alt || message('reader.unnamedImage');
  const components: Components = {
    a: ({ href, children }) =>
      attachmentId(href) ? (
        <AttachmentLink id={attachmentId(href)!}>{children}</AttachmentLink>
      ) : href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    img: ({ src, alt }) =>
      attachmentId(src) ? (
        <AttachmentImage id={attachmentId(src)!} alt={imageAlt(alt)} />
      ) : (
        <span>{message('reader.imageFallback', { alt: imageAlt(alt) })}</span>
      ),
  };
  return (
    <div
      className={
        'markdown-content break-words leading-relaxed [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_li]:ml-6 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc' +
        (framed ? ' rounded-lg border p-6' : '')
      }
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        urlTransform={(url, key, node) =>
          ((key === 'src' && node.tagName === 'img') ||
            (key === 'href' && node.tagName === 'a')) &&
          attachmentId(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
