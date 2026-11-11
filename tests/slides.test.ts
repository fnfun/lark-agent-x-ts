import { describe, expect, test } from 'bun:test';
import { SlidesEditor } from '../src/domains/slides.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;
type Change = { id: string; version: number; payload: { ops: { p: unknown[]; action: Dict }[] } };

const DECK = 'sldabAAAAAAAAAAAAAAAAAAAAAA';
const text = (t: string) => ({
  apool: { nextNum: 1, numToAttrib: { 0: ['lmkr', '1'] } },
  initialAttributedTexts: { text: { 0: `*${t}` }, attribs: { 0: `*0+1+${t.length.toString(36)}` } },
});
const shape = (parent: string, t: string) => ({
  version: 2,
  data: { type: 'shape', parent_id: parent, shape: { text: { content: text(t) } } },
});

/** A deck of pages P1 (shape s1) and P2 (shape s2, notes n2, an animation on s2); layout L has shape l1. */
function fakeDeck() {
  const commits: Record<string, Change>[] = [];
  const web = {
    json: async (_m: string, _p: string, o: WebRequest = {}) => {
      if (o.json === undefined)
        return {
          code: 0,
          data: {
            block_map: {
              [DECK]: { version: 7, data: { type: 'deck', slides: ['P1', 'P2'] } },
              P1: {
                version: 1,
                data: { type: 'slide', parent_id: DECK, children: ['s1'], slide: { layout: 'L' } },
              },
              P2: {
                version: 1,
                data: {
                  type: 'slide',
                  parent_id: DECK,
                  children: ['s2'],
                  slide: { layout: 'L', note: 'n2' },
                  animation_timeline: [{ target: 's2' }],
                },
              },
              n2: { version: 1, data: { type: 'note', parent_id: 'P2' } },
              s1: shape('P1', '季度回顾'),
              s2: shape('P2', '季度要点'),
              l1: shape('L', '季度'),
            },
          },
        };
      commits.push((o.json as { change_map: Record<string, Change> }).change_map);
      return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
    },
  } as unknown as WebSession;
  return { slides: new SlidesEditor(web), commits };
}

describe('幻灯片编辑', () => {
  test('复制页：页、备注、形状换成新 id，内部引用（备注、动画、父块）一起换；版式不动；插到指定位置', async () => {
    const { slides, commits } = fakeDeck();
    expect(await slides.copyPage(DECK, 2, { at: 1 })).toBe(1);
    const change = commits[0] as Record<string, Change>;
    expect(change[DECK]?.version).toBe(7);
    const op = change[DECK]?.payload.ops[0];
    expect(op?.p).toEqual(['slides', 0]);
    const page = change[op?.action.li as string]?.payload.ops[0]?.action.oi as Dict & {
      children: string[];
      slide: { note: string; layout: string };
      animation_timeline: { target: string }[];
    };
    const [shapeId] = page.children;
    expect(page.parent_id).toBe(DECK);
    expect(page.slide.layout).toBe('L');
    expect(page.animation_timeline[0]?.target).toBe(shapeId as string);
    expect(shapeId).toMatch(/^sldab[0-9A-Za-z]{22}$/);
    const copied = change[shapeId as string]?.payload.ops[0]?.action.oi as Dict;
    expect(copied.parent_id).toBe(op?.action.li as string);
    expect(change[page.slide.note]?.payload.ops[0]?.action.oi).toMatchObject({
      type: 'note',
      parent_id: op?.action.li,
    });
    expect(Object.keys(change)).toHaveLength(4);
    await expect(slides.copyPage(DECK, 3)).rejects.toThrow('没有第 3 页');
  });

  test('删页：从后往前删；不能删光；页码不存在时什么都不提交', async () => {
    const { slides, commits } = fakeDeck();
    await expect(slides.removePages(DECK, [1, 2])).rejects.toThrow('不能删掉所有页');
    await expect(slides.removePages(DECK, [5])).rejects.toThrow('没有第 5 页');
    expect(commits).toHaveLength(0);
    expect(await slides.removePages(DECK, [1, 1])).toBe(1);
    expect(commits[0]?.[DECK]?.payload.ops).toEqual([{ p: ['slides', 0], action: { ld: 'P1' } }]);
  });

  test('替换文字：只改页面里的形状（不碰版式），保留行标记属性；--page 只改那一页', async () => {
    const { slides, commits } = fakeDeck();
    expect(await slides.replace(DECK, '季度', '年度')).toEqual({
      replaced: 2,
      blocks: 2,
      skipped: 0,
    });
    expect(Object.keys(commits[0] as Dict).sort()).toEqual(['s1', 's2']);
    expect(commits[0]?.s1?.payload.ops[0]).toMatchObject({
      p: ['shape', 'text', 'content'],
      action: {
        oi: { initialAttributedTexts: { text: { 0: '*年度回顾' }, attribs: { 0: '*0+1+4' } } },
      },
    });
    await slides.replace(DECK, '季度', '年度', { page: 2 });
    expect(Object.keys(commits[1] as Dict)).toEqual(['s2']);
  });
});
