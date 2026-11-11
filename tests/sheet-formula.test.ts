import { describe, expect, test } from 'bun:test';
import { compileFormula } from '../src/domains/sheet-formula.js';

// Expected values are what the Sheets web app sent for these formulas typed into a sheet.
const cell = (row: number, col: number, type = 0, rowCount = 1, colCount = 1) => ({
  type,
  col,
  colCount,
  row,
  rowCount,
});

describe('表格公式', () => {
  test('引用、数字、乘法和函数', () => {
    expect(compileFormula('=A1*2+SUM(A1:A3)')).toEqual({
      v: 1,
      refs: { R1: cell(0, 0), R2: cell(0, 0, 0, 3) },
      tree: ['R1', 'D2', 'OB*', 'R2', 'F:SUM:1', 'OB+'],
      tokens: ['R1', 'C*2+SUM(', 'R2', 'C)'],
    });
  });

  test('比较、字符串、连接、一元负号、百分号、括号、绝对行', () => {
    expect(compileFormula('=IF(A1>=1,"大","小")&-A2%+B$3/(2.5-1)')).toEqual({
      v: 1,
      refs: { R1: cell(0, 0), R2: cell(1, 0), R3: cell(2, 1, 192) },
      tree: [
        'R1',
        'D1',
        'OB>=',
        'S大',
        'S小',
        'F:IF:3',
        'R2',
        'OP-',
        'OS%',
        'R3',
        'D2.5',
        'D1',
        'OB-',
        'OG1',
        'OB/',
        'OB+',
        'OB&',
      ],
      tokens: ['CIF(', 'R1', 'C>=1,"大","小")&-', 'R2', 'C%+', 'R3', 'C/(2.5-1)'],
    });
  });

  test('整列引用和多参数函数', () => {
    expect(compileFormula('=SUM(A:A)+A1+COUNTA(A1:B3,1)')).toEqual({
      v: 1,
      refs: { R1: { type: 2, col: 0, colCount: 1 }, R2: cell(0, 0), R3: cell(0, 0, 0, 3, 2) },
      tree: ['R1', 'F:SUM:1', 'R2', 'OB+', 'R3', 'D1', 'F:COUNTA:2', 'OB+'],
      tokens: ['CSUM(', 'R1', 'C)+', 'R2', 'C+COUNTA(', 'R3', 'C,1)'],
    });
  });

  test('各种绝对引用、整行引用和乘方', () => {
    expect(compileFormula('=$A1+$A$1+A$1+SUM($A1:B$2)+SUM(1:2)+2^3')).toEqual({
      v: 1,
      refs: {
        R1: cell(0, 0, 48),
        R2: cell(0, 0, 240),
        R3: cell(0, 0, 192),
        R4: cell(0, 0, 144, 2, 2),
        R5: { type: 1, row: 0, rowCount: 2 },
      },
      tree: [
        'R1',
        'R2',
        'OB+',
        'R3',
        'OB+',
        'R4',
        'F:SUM:1',
        'OB+',
        'R5',
        'F:SUM:1',
        'OB+',
        'D2',
        'D3',
        'OB^',
        'OB+',
      ],
      tokens: ['R1', 'C+', 'R2', 'C+', 'R3', 'C+SUM(', 'R4', 'C)+SUM(', 'R5', 'C)+2^3'],
    });
  });

  test('引用其他工作表、括号不配对时报错', () => {
    expect(() => compileFormula('=Sheet2!A1')).toThrow('其他工作表');
    expect(() => compileFormula('=SUM(A1')).toThrow('括号');
  });
});
