import type { BookProject, Chapter } from '../types/novel';
import { buildZipStore, downloadBytes } from './zipStore';
import { sanitizeProjectForExport } from './projectTransfer';

function escapeXml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeFileBaseName(title: string): string {
  const base = (title || '未命名小说')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40);
  return base || 'novel';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 正文 → 简单 HTML 段落 */
function proseToHtml(content: string): string {
  const t = (content || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '<p>（空）</p>';
  return t
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeXml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

function chapterXhtml(ch: Chapter, bookTitle: string): string {
  const title = `第 ${ch.number} 章 ${ch.title || ''}`.trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h1 class="chapter-title">${escapeXml(title)}</h1>
  ${ch.summary?.trim() ? `<p class="summary">${escapeXml(ch.summary.trim())}</p>` : ''}
  <div class="body">
${proseToHtml(ch.content)}
  </div>
  <p class="book-foot">${escapeXml(bookTitle)}</p>
</body>
</html>`;
}

const STYLESHEET = `body {
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", Georgia, serif;
  line-height: 1.85;
  margin: 1.2em 1em;
  color: #1a1a1a;
}
h1.chapter-title {
  font-size: 1.35em;
  text-align: center;
  margin: 1.5em 0 1em;
  font-weight: bold;
}
p.summary {
  color: #666;
  font-size: 0.9em;
  border-left: 3px solid #ccc;
  padding-left: 0.8em;
  margin-bottom: 1.5em;
}
div.body p {
  text-indent: 2em;
  margin: 0.6em 0;
}
p.book-foot {
  margin-top: 2.5em;
  text-align: center;
  color: #999;
  font-size: 0.8em;
}
`;

/**
 * 导出 EPUB 2 兼容包（可在多数阅读器打开）。
 * 仅正文+简介；不含设定/API 密钥。
 */
export function exportProjectAsEpub(
  project: BookProject,
  options?: { approvedOnly?: boolean }
): { filename: string; chapterCount: number } {
  const p = sanitizeProjectForExport(project);
  let chapters = [...(p.chapters || [])].sort((a, b) => a.number - b.number);
  if (options?.approvedOnly) {
    chapters = chapters.filter(
      (c) =>
        c.status === '校验通过' ||
        c.status === '精修定稿' ||
        c.status === '校验精修定稿' ||
        c.locked === true
    );
  }
  // 至少导出有正文的章
  const withBody = chapters.filter((c) => (c.content || '').trim().length > 0);
  const list = withBody.length > 0 ? withBody : chapters;

  if (list.length === 0) {
    throw new Error('没有可导出的章节（请先写正文）');
  }

  const bookId = `urn:uuid:novel-${p.id || Date.now()}`;
  const title = p.title || '未命名小说';
  const author = p.author || '佚名';
  const lang = 'zh-CN';

  const manifestItems: string[] = [
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="stylesheet.css" media-type="text/css"/>`,
  ];
  const spineItems: string[] = [];
  const navPoints: string[] = [];
  const entries: { path: string; data: string | Uint8Array }[] = [];

  // mimetype 必须第一且无压缩（我们全部 STORE，OK）
  entries.push({ path: 'mimetype', data: 'application/epub+zip' });
  entries.push({
    path: 'META-INF/container.xml',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  });
  entries.push({ path: 'OEBPS/stylesheet.css', data: STYLESHEET });

  list.forEach((ch, i) => {
    const id = `chap${ch.number}`;
    const href = `chapter_${String(ch.number).padStart(4, '0')}.xhtml`;
    manifestItems.push(
      `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`
    );
    spineItems.push(`<itemref idref="${id}"/>`);
    navPoints.push(`  <navPoint id="nav${i}" playOrder="${i + 1}">
    <navLabel><text>${escapeXml(`第 ${ch.number} 章 ${ch.title || ''}`.trim())}</text></navLabel>
    <content src="${href}"/>
  </navPoint>`);
    entries.push({
      path: `OEBPS/${href}`,
      data: chapterXhtml(ch, title),
    });
  });

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator opf:role="aut">${escapeXml(author)}</dc:creator>
    <dc:language>${lang}</dc:language>
    <dc:identifier id="BookId">${escapeXml(bookId)}</dc:identifier>
    <dc:description>${escapeXml((p.synopsis || p.config?.inspiration || '').slice(0, 500))}</dc:description>
    <dc:subject>${escapeXml(p.genre || '小说')}</dc:subject>
    <meta name="cover" content=""/>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints.join('\n')}
  </navMap>
</ncx>`;

  entries.push({ path: 'OEBPS/content.opf', data: opf });
  entries.push({ path: 'OEBPS/toc.ncx', data: ncx });

  const zip = buildZipStore(entries);
  const filename = `${safeFileBaseName(title)}_${stamp()}.epub`;
  downloadBytes(filename, zip, 'application/epub+zip');
  return { filename, chapterCount: list.length };
}
