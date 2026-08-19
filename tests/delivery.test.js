/**
 * `deliveryFor()` — table-driven, because the whole point of the function is
 * a short list of rules that must never regress silently. No server, no
 * database: this is the pure function itself.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFor, round2 } from '../src/shared/delivery.js';



const CASES = [
  {
    name: 'flat',
    goodsTotal: 300,
    settings: { mode: 'flat', fee: 50, percent: 0, min: null, max: null, freeOver: null },
    expect: 50,
  },
  {
    name: 'percent',
    goodsTotal: 400,
    settings: { mode: 'percent', fee: 50, percent: 10, min: null, max: null, freeOver: null },
    expect: 40,
  },
  {
    name: 'percent below min',
    goodsTotal: 40,
    settings: { mode: 'percent', fee: 50, percent: 10, min: 20, max: null, freeOver: null },
    expect: 20, // 10% of 40 = 4, floored to the 20 minimum
  },
  {
    name: 'percent above max',
    goodsTotal: 5000,
    settings: { mode: 'percent', fee: 50, percent: 10, min: null, max: 100, freeOver: null },
    expect: 100, // 10% of 5000 = 500, capped at 100
  },
  {
    name: 'free-over reached, flat mode',
    goodsTotal: 2000,
    settings: { mode: 'flat', fee: 50, percent: 0, min: null, max: null, freeOver: 2000 },
    expect: 0,
  },
  {
    name: 'free-over reached, percent mode',
    goodsTotal: 2000,
    settings: { mode: 'percent', fee: 0, percent: 10, min: null, max: null, freeOver: 2000 },
    expect: 0,
  },
  {
    name: 'percent, no min and no max',
    goodsTotal: 733,
    settings: { mode: 'percent', fee: 50, percent: 7, min: null, max: null, freeOver: null },
    expect: round2((733 * 7) / 100),
  },
  {
    name: 'NaN/missing setting (percent is undefined)',
    goodsTotal: 500,
    settings: { mode: 'percent', fee: 50, min: null, max: null, freeOver: null }, // percent missing
    expect: 0,
  },
  {
    name: 'negative stored fee',
    goodsTotal: 300,
    settings: { mode: 'flat', fee: -75, percent: 0, min: null, max: null, freeOver: null },
    expect: 0, // never negative
  },
];

test('deliveryFor — the shipping rule, one row per case', () => {
  const rows = CASES.map((c) => {
    const actual = deliveryFor(c.goodsTotal, c.settings);
    return { name: c.name, goodsTotal: c.goodsTotal, expect: c.expect, actual, pass: actual === c.expect };
  });

  // Printed so `npm test` output shows the table, not just a pass count.
  console.log('\n  deliveryFor table:');
  console.log('  ' + 'case'.padEnd(38) + 'goods'.padEnd(9) + 'expect'.padEnd(9) + 'actual'.padEnd(9) + 'pass');
  for (const r of rows) {
    console.log(
      '  ' + r.name.padEnd(38) + String(r.goodsTotal).padEnd(9)
      + String(r.expect).padEnd(9) + String(r.actual).padEnd(9) + (r.pass ? 'PASS' : 'FAIL'),
    );
  }

  for (const r of rows) {
    assert.equal(r.actual, r.expect, `${r.name}: expected ${r.expect}, got ${r.actual}`);
  }
});
