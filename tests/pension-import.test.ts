import { describe, expect, it } from 'vitest';
import { normalize, parseReport } from '../src/server/routes/pensionImport';
import { importPensionReport } from '../src/import/pensionReport';
import { testDb } from './helpers.js';

// what Claude answers for a (made-up) report: partial summary, a stray sentence around the JSON
const answer = `Here is the data:
{"asOf":"2026-06-30","agent":{"name":"ישראל ישראלי"},"summary":{"totalSavings":330000,"ytdReturnPct":5.1},
 "products":[{"type":"pension","name":"מקיפה","provider":"מגדל","policyNumber":"111-222","balance":250000,"status":"active","feeBalance":0.2},
  {"type":"keren_hishtalmut","name":"השתלמות כללי","provider":"הראל","policyNumber":"333-444","balance":80000,"status":"active","joinDate":"2018-03-01"}]}`;

describe('pension report import from the UI', () => {
  it('reads Claude answer, fills what the page needs and imports it', () => {
    const report = normalize(parseReport(answer));
    expect(report.summary.totalSavings).toBe(330000);
    expect(report.statedTotal).toBe(330000);
    expect(report.summary.expectedAnnuity.totalWithoutDeposits).toBe(0);
    const db = testDb();
    const member = db.prepare(`SELECT name FROM members WHERE id = 1`).pluck().get() as string;
    const result = importPensionReport(db, { ...report, member, source: 'דוח תקופתי מהסוכן', file: 'r.pdf' });
    expect(result).toMatchObject({ assets: 2, created: 2 });
    // importing the same report again updates, never duplicates
    expect(importPensionReport(db, { ...report, member, source: 'דוח תקופתי מהסוכן', file: 'r.pdf' }).created).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) FROM pension_reports`).pluck().get()).toBe(1);
  });
});
