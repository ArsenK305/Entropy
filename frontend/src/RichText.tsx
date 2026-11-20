import type { ElementType, ReactNode } from "react";

type BlockType = "paragraph" | "heading" | "list" | "quote" | "code";
interface Block {
  type: BlockType;
  lines: string[];
  level?: number;
  ordered?: boolean;
  language?: string;
}

const blockStart = /^(#{1,6}\s+|\s*[-*+]\s+|\s*\d+[.)]\s+|>\s?|```)/;

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\[[^\]\n]{1,240}\]\(https:\/\/(?:drive|docs)\.google\.com\/[^\s)]{1,2048}\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/);
    if (link) {
      try {
        const parsed = new URL(link[2]);
        if (parsed.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(parsed.hostname)) {
          parts.push(<a key={match.index} href={parsed.href} target="_blank" rel="noopener noreferrer">{link[1]}</a>);
        } else {
          parts.push(token);
        }
      } catch {
        parts.push(token);
      }
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function parseBlocks(value: string): Block[] {
  const lines = value.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```\s*([\w+-]*)/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lines: code, language: fence[1] });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, lines: [heading[2]] });
      index += 1;
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ type: "list", lines: items, ordered });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", lines: quote });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !blockStart.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

export default function RichText({ text }: { text: string }) {
  return <div className="rich-text">{parseBlocks(text).map((block, index) => {
    if (block.type === "heading") {
      const level = Math.min(block.level || 3, 4);
      const Heading = `h${level}` as ElementType;
      return <Heading key={index}>{inline(block.lines[0])}</Heading>;
    }
    if (block.type === "list") {
      const List = block.ordered ? "ol" : "ul";
      return <List key={index}>{block.lines.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</List>;
    }
    if (block.type === "quote") return <blockquote key={index}>{block.lines.map((line, lineIndex) => <p key={lineIndex}>{inline(line)}</p>)}</blockquote>;
    if (block.type === "code") return <pre key={index} data-language={block.language || undefined}><code>{block.lines.join("\n")}</code></pre>;
    const paragraph = block.lines.join(" ");
    const sourceMatch = paragraph.match(/^Источники(\s+RAG)?:\s*(.+)$/i);
    if (sourceMatch) {
      const sources = sourceMatch[2].split(/;\s*/).map((source) => source.trim()).filter(Boolean);
      const label = sourceMatch[1] ? "Источники RAG" : "Источники";
      if (sources.length) return <details className="rich-sources" key={index}><summary><span>{label}</span><small>{sources.length}</small></summary><ul>{sources.map((source, sourceIndex) => <li key={`${sourceIndex}-${source}`}>{inline(source)}</li>)}</ul></details>;
    }
    return <p key={index}>{block.lines.map((line, lineIndex) => <span key={lineIndex}>{lineIndex > 0 && <br />}{inline(line)}</span>)}</p>;
  })}</div>;
}
