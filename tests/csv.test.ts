import { describe, expect, test } from 'bun:test';
import { parseCsv, toCsv } from '../src/csv.js';

describe('CSV', () => {
  test('解析：引号里的逗号、换行和成对引号；CRLF 与 LF 都算换行；BOM 不进第一格；末尾换行不多出空行', () => {
    const text = '﻿名称,备注\r\n苹果,"红的,甜的"\n"香""蕉""","第一行\r\n第二行"\n,\n';
    expect(parseCsv(text)).toEqual([
      ['名称', '备注'],
      ['苹果', '红的,甜的'],
      ['香"蕉"', '第一行\r\n第二行'],
      ['', ''],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(() => parseCsv('a,"b\n')).toThrow('引号');
  });

  test('生成：只给需要的格子加引号，引号成双；能原样解析回来', () => {
    const rows = [
      ['名称', '备注', '数量'],
      ['苹果', '红的,甜的', '3'],
      ['香"蕉"', '第一行\n第二行', ''],
    ];
    const csv = toCsv(rows);
    expect(csv).toBe('名称,备注,数量\n苹果,"红的,甜的",3\n"香""蕉""","第一行\n第二行",');
    expect(parseCsv(csv)).toEqual(rows);
  });
});
