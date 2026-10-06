import type { FastifyInstance } from 'fastify';
import { SCRAPERS } from 'israeli-bank-scrapers';
import type { DB } from '../../db/connection.js';
import { recordScrapeRun, saveScrapedAccount } from '../../db/ingestRepo.js';
import { localDate, type ScrapedAccount, type ScrapedTransaction } from '../../ingest/normalize.js';
import { runPipeline } from '../../pipeline.js';

/**
 * Manual upload: rows from a bank / card statement file (Excel or CSV exported from the bank's
 * website), parsed and mapped in the browser. They are saved like a scrape of that company, so
 * the account behaves exactly like a connected one; uploading the same file twice adds nothing.
 */
interface ImportRow {
  date: string; processedDate?: string | null; description: string; amount: number;
  originalAmount?: number | null; currency?: string | null; memo?: string | null;
  installmentNumber?: number | null; installmentTotal?: number | null;
}
interface ImportBody { companyId: string; accountLabel: string; ownerMemberId?: number | null; balance?: number | null; fileName?: string | null; rows: ImportRow[] }

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight in Israel as an ISO instant — the same form the scrapers return (e.g. 2026-01-06T22:00:00.000Z). */
function israelMidnight(day: string): string {
  for (const offset of ['+02:00', '+03:00']) {
    const iso = new Date(`${day}T00:00:00${offset}`).toISOString();
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    if (localDate(iso) === day && hour === '00') return iso;
  }
  return new Date(`${day}T00:00:00+02:00`).toISOString();
}

export function importRoutes(app: FastifyInstance, db: DB) {
  // the files uploaded so far, newest first
  app.get('/api/import/history', async () => (db.prepare(`
    SELECT u.id, u.account_id AS accountId, a.display_name AS accountName, a.owner_member_id AS ownerMemberId, u.file_name AS fileName,
      u.uploaded_at AS uploadedAt, u.rows, u.inserted, u.from_date AS fromDate, u.to_date AS toDate, u.balance
    FROM uploads u LEFT JOIN accounts a ON a.id = u.account_id ORDER BY u.uploaded_at DESC, u.id DESC
  `).all()));

  app.post('/api/import', { bodyLimit: 20 * 1024 * 1024 }, async req => {
    const b = req.body as ImportBody;
    if (!(SCRAPERS as Record<string, unknown>)[b?.companyId]) throw badRequest(`unknown company: ${b?.companyId}`);
    const label = String(b.accountLabel ?? '').trim().replace(/[:\s]+/g, '-');
    if (!label) throw badRequest('accountLabel is required (e.g. the last 4 digits)');
    if (!Array.isArray(b.rows) || !b.rows.length) throw badRequest('no rows to import');

    const txns = b.rows.map((r, i): ScrapedTransaction => {
      if (!DAY.test(r.date)) throw badRequest(`row ${i + 1}: bad date ${r.date}`);
      if (r.processedDate && !DAY.test(r.processedDate)) throw badRequest(`row ${i + 1}: bad charge date ${r.processedDate}`);
      if (!Number.isFinite(r.amount)) throw badRequest(`row ${i + 1}: bad amount`);
      const description = String(r.description ?? '').trim();
      if (!description) throw badRequest(`row ${i + 1}: no description`);
      const installments = r.installmentTotal && r.installmentTotal > 1
        ? { number: r.installmentNumber ?? 1, total: r.installmentTotal } : undefined;
      return {
        type: (installments ? 'installments' : 'normal') as ScrapedTransaction['type'],
        date: israelMidnight(r.date),
        processedDate: israelMidnight(r.processedDate || r.date),
        originalAmount: Number.isFinite(r.originalAmount) ? r.originalAmount! : r.amount,
        originalCurrency: r.currency?.trim() || 'ILS',
        chargedAmount: r.amount,
        description,
        memo: r.memo?.trim() || undefined,
        status: 'completed' as ScrapedTransaction['status'],
        installments,
      } as ScrapedTransaction;
    });

    const hasBalance = b.balance != null && Number.isFinite(b.balance);
    const account = { accountNumber: label, txns, ...(hasBalance ? { balance: b.balance } : {}) } as ScrapedAccount;
    const startedAt = new Date().toISOString();
    const saved = db.transaction(() => {
      const res = saveScrapedAccount(db, b.companyId, account, { recordBalance: hasBalance });
      if (b.ownerMemberId) db.prepare(`UPDATE accounts SET owner_member_id = ? WHERE id = ? AND owner_member_id IS NULL`).run(b.ownerMemberId, res.accountId);
      return res;
    })();
    recordScrapeRun(db, { company: b.companyId, startedAt, success: true, newTransactions: saved.insertedIds.length });
    const days = b.rows.map(r => r.date).sort();
    db.prepare(`INSERT INTO uploads (account_id, file_name, rows, inserted, from_date, to_date, balance) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(saved.accountId, b.fileName?.trim().slice(0, 200) || null, txns.length, saved.insertedIds.length, days[0], days[days.length - 1], hasBalance ? b.balance : null);
    const pipeline = await runPipeline(db, { txIds: saved.insertedIds });
    return { accountId: saved.accountId, rows: txns.length, inserted: saved.insertedIds.length, updated: saved.updated, pipeline };
  });
}
