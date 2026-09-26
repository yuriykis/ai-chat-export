// Turns a list of chat messages into the Markdown body of an Obsidian note.

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

// The chat text must not change the vault: `- [ ]` would become a task (Tasks plugin), `#word` a tag,
// and `# Heading` would break the note's outline. Fenced code is left verbatim.
export function sanitize(text) {
  let fence = null;
  const lines = text.split('\n').map((line) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    line = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/, '$1\\[$2]');
    line = line.replace(/^#{1,6}(?=\s)/, (h) => '#'.repeat(Math.min(h.length + 2, 6)));
    return line
      .split(/(`+[^`]*`+)/)
      .map((seg, i) => (i % 2 ? seg : seg.replace(/(^|[^\w\\&#/])#(?=[\p{L}_/-]*[\p{L}_])/gu, '$1\\#')))
      .join('');
  });
  if (fence) lines.push(fence); // an unclosed fence would swallow every heading after it
  return lines.join('\n');
}

export function renderBody(messages, labels) {
  let lastDay = null;
  return messages
    .map((m) => {
      const d = m.ts ? new Date(m.ts) : new Date();
      const day = ymd(d);
      const when = lastDay && day !== lastDay ? `${dm(d)} ${hm(d)}` : hm(d);
      lastDay = day;
      return `## ${labels[m.role]} · ${when}\n\n${sanitize(m.text)}\n`;
    })
    .join('\n');
}

// Quote only what YAML would misread, so dates stay plain dates like in hand-written notes.
export const yamlValue = (v) =>
  typeof v === 'string' && (/[[\]{}:#,&*!|>'"%@`]/.test(v) || v !== v.trim() || !v) ? JSON.stringify(v) : String(v);

function yamlField(key, value) {
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return `${key}:`;
  if (Array.isArray(value)) return `${key}:\n${value.map((v) => `  - ${yamlValue(v)}`).join('\n')}`;
  return `${key}: ${yamlValue(value)}`;
}

export function renderFrontmatter(fields) {
  return `---\n${Object.entries(fields).map(([k, v]) => yamlField(k, v)).join('\n')}\n---\n`;
}
