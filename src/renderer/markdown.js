// Rendu Markdown minimal et sûr : on échappe tout le texte, puis on ré-introduit
// uniquement les balises que l'on génère nous-mêmes.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])

function emphasis(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext>$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-ext>$2</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
}

// Découpe sur les backticks : les segments impairs sont du code inline.
function inline(text) {
  const parts = String(text).split('`')
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1 && i < parts.length - 1) out += `<code>${escapeHtml(parts[i])}</code>`
    else out += emphasis(i % 2 === 1 ? `\`${parts[i]}` : parts[i])
  }
  return out
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n')
  const html = []
  let i = 0
  let list = null

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // bloc de code
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1] || ''
      const buf = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++
      const attr = lang ? ` data-lang="${escapeHtml(lang)}"` : ''
      html.push(`<pre class="code"${attr}><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      closeList()
      i++
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length + 2, 6)
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList()
      html.push('<hr>')
      i++
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeList()
      const buf = [quote[1]]
      i++
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`)
      continue
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul class="tasks">')
        list = 'ul'
      }
      const done = task[1].toLowerCase() === 'x'
      html.push(`<li class="task${done ? ' done' : ''}"><span class="box">${done ? '✓' : ''}</span>${inline(task[2])}</li>`)
      i++
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul>')
        list = 'ul'
      }
      html.push(`<li>${inline(bullet[1])}</li>`)
      i++
      continue
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numbered) {
      if (list !== 'ol') {
        closeList()
        html.push('<ol>')
        list = 'ol'
      }
      html.push(`<li>${inline(numbered[1])}</li>`)
      i++
      continue
    }

    // paragraphe
    closeList()
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }

  closeList()
  return html.join('')
}
