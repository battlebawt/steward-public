import {expect,test} from 'bun:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BudgetSummary} from '../src/components/Primitives';

test('V2 budget labels conservative expired-order charges separately from reservations and never claims a fill',()=>{
  const html=renderToStaticMarkup(createElement(BudgetSummary,{budget:{limitRaw:'100',spentRaw:'20',remainingRaw:'80',unit:'MOCK',decimals:0,resetAtUtc:'2026-09-26T00:00:00.000Z',pendingRequests:0,buyBudget:{limitRaw:'1000',chargedRaw:'150',pendingRaw:'200',availableRaw:'650'}}}));
  expect(html).toContain('Buy budget');
  expect(html).toContain('650');
  expect(html).toContain('Charged against this limit:');
  expect(html).toContain('150');
  expect(html).toContain('Reserved by pending CoW orders:');
  expect(html).toContain('200');
  expect(html).toContain('expired unresolved orders');
  expect(html).toContain('does not prove a fill');
  expect(html).not.toContain('Completed:');
});
