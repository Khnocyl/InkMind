/**
 * 灵感火花：让模型按题材批量脑暴「一句话故事起点」，
 * 供向导第一步「灵感火花速选」刷新使用。
 * 与正文不同——这里要的是发散、反套路、高概念密度，不做任何纪律约束。
 */
import { generateJSON } from './llmClient';

export interface InspirationSpark {
  title: string;
  text: string;
  genre: string;
}

interface SparksResponse {
  sparks: InspirationSpark[];
}

const MAX_SPARKS = 6;

/**
 * 按题材生成一批灵感火花。
 * - genre: 当前题材标签（模型会围绕它定向脑暴，并回填更精准的子分类标签）
 * - count: 生成条数（默认 6）
 * 返回的每条含 title/text/genre，可直接填充向导表单。
 */
export async function generateInspirationSparks(
  genre: string,
  count = MAX_SPARKS
): Promise<InspirationSpark[]> {
  const n = Math.min(10, Math.max(1, Math.round(count)));
  const messages = [
    {
      role: 'system',
      content:
        '你是网文题材策划脑暴官。任务：围绕指定题材，脑暴一批「一句话故事起点」灵感火花。',
    },
    {
      role: 'user',
      content:
        `题材方向：${genre || '不限（自由发散）'}\n` +
        `请生成 ${n} 条相互差异明显的灵感火花，每条包含：\n` +
        '- title：10 字内的小标题（含流派标签，如「东方玄幻 · 逆命禁忌」）\n' +
        '- text：80-160 字的故事起点描述。必须包含：一个具体到可拍画面开局处境 + 主角金手指或独特机缘 + 一个反常规的核心冲突/悬念钩子。\n' +
        '- genre：8-14 字的精确题材子分类\n' +
        '要求：反套路、高概念、有记忆点；六条之间在题材处理方式上明显不同（不要六条都是同一种开局）。\n' +
        '严格只输出合法 JSON，结构：' +
        '{"sparks":[{"title":"…","text":"…","genre":"…"}]}',
    },
  ];
  const res = await generateJSON<SparksResponse>(messages, 0.9, {
    validate: (v) => {
      const list = Array.isArray(v?.sparks) ? v.sparks : [];
      if (list.length === 0) return 'sparks 数组缺失或为空';
      for (const s of list) {
        if (!s || typeof s.title !== 'string' || typeof s.text !== 'string') {
          return '存在条目缺 title/text';
        }
      }
      return null;
    },
  });
  return (res.sparks || [])
    .slice(0, n)
    .map((s) => ({
      title: String(s.title || '').trim().slice(0, 40),
      text: String(s.text || '').trim(),
      genre: String(s.genre || genre || '').trim().slice(0, 24),
    }))
    .filter((s) => s.title && s.text);
}
