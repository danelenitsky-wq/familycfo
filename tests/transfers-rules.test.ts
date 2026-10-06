import { describe, expect, it } from 'vitest';
import { isGenericTransfer, ruleMatches, type Rule } from '../src/ingest/classify';

const rule = (r: Partial<Rule>): Rule => ({ id: 1, match_type: 'exact', pattern: 'העברה דיגיטל', account_id: null, min_amount: null, max_amount: null,
  set_category_id: 1, set_business_id: null, set_business_share_pct: null, set_member_id: null, set_kind: null, set_tag_ids: null, priority: 10, ...r });

describe('generic transfers', () => {
  it('recognises transfers that say nothing about their purpose', () => {
    expect(isGenericTransfer('העברה דיגיטל')).toBe(true);
    expect(isGenericTransfer('העברה ב BIT בנה"פ')).toBe(true);
    expect(isGenericTransfer('שופרסל דיל')).toBe(false);
  });
  it('a same-amount rule matches only that amount', () => {
    const r = rule({ min_amount: 10000, max_amount: 10000 });
    expect(ruleMatches(r, { description: 'העברה דיגיטל', account_id: 'x', charged_amount: -10000 })).toBe(true);
    expect(ruleMatches(r, { description: 'העברה דיגיטל', account_id: 'x', charged_amount: -4500 })).toBe(false);
  });
});
