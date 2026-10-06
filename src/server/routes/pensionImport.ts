import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { importPensionReport } from '../../import/pensionReport.js';
import { REPORTS_DIR } from './insurance.js';

/**
 * Import a periodic pension report (from the insurance agent, or the pension clearinghouse — המסלקה הפנסיונית)
 * from the UI. Every provider lays its report out differently, so the user's own Claude Code (`claude -p`, as the
 * data chat does) reads the file and returns it in the importer's JSON shape. Claude can only Read the one file,
 * in a work dir outside the repo. The user sees a preview and confirms; only then is it imported (and the file kept
 * in data/reports/, listed on the page).
 */

const ROOT = resolve('.');
const WORKDIR = join(tmpdir(), 'household-pension-import');
const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = any;
const drafts = new Map<string, { report: Report; fileName: string; memberId: number; source: string; createdAt: number }>();

const SCHEMA = `{
  "asOf": "YYYY-MM-DD — the date the balances are valid for",
  "issuedAt": "YYYY-MM-DD or null",
  "agent": { "name": "", "agency": "", "phone": "", "email": "" } or null,
  "summary": {
    "totalSavings": number (sum of all product balances, ₪),
    "ytdReturnPct": number (weighted return since the start of the year, %, 0 if not given),
    "lifeHealthMonthlyPremium": number (0 if not given),
    "byProductType": [{ "name": "", "amount": number, "pct": number }],
    "byProvider": [{ "name": "", "amount": number, "pct": number }],
    "tradedPct": { "traded": number, "nonTraded": number },
    "exposurePct": { "stocks": number, "abroad": number, "foreignCurrency": number },
    "assetMixPct": [{ "name": "", "pct": number }],
    "monthlyDeposits": { "total": number, "<product type name>": number },
    "expectedAnnuity": { "pensionWithoutDeposits": number, "pensionWithDeposits": number, "managers": number, "totalWithoutDeposits": number },
    "coverage": { "disability": number, "death": number, "noInfo": [""] }
  },
  "products": [{
    "type": "pension" (pension fund or managers' insurance) | "keren_hishtalmut" (study fund) | "kupat_gemel" (provident fund, incl. investment gemel),
    "name": "the product / fund name", "provider": "the managing company", "policyNumber": "", "balance": number,
    "feeDeposit": number|null (% of deposits), "feeBalance": number|null (% of balance per year),
    "employer": ""|null, "status": "active"|"inactive", "joinDate": "YYYY-MM-DD"|null, "lastDeposit": "YYYY-MM-DD"|null,
    "regularDeposit": number|null (monthly), "insuredSalary": number|null,
    "expectedAnnuity": number|null, "expectedAnnuityWithDeposits": number|null, "agentOfRecord": ""|null,
    "tracks": [{ "name": "", "share": number (%), "balance": number,
      "returns": [last month, year to date, 12 months, 3 years, 5 years, 3-year average, 5-year average] (% or null) }],
    "components": { "pitzuyim": number, "tagmulim": number, "capital": number } or null,
    "coverages": [{ "name": "", "pct": number, "monthly": number }],
    "coverageCost": { "disability": number, "survivors": number } or null,
    "deposits": [["value date YYYY-MM-DD", "salary month YYYY-MM"|null, salary|null, employee|null, employer|null, severance|null, total]]
  }],
  "insurance": [{ "name": "", "type": "life"|"health"|"disability"|"nursing"|"critical_illness"|"other", "insurer": "", "policyNumber": "",
    "premium": number, "premiumFrequency": "monthly"|"yearly", "startDate": "YYYY-MM-DD"|null, "coverage": ""|null }]
}`;

function prompt(fileName: string): string {
  return `Read the file ./${fileName} — a periodic Israeli pension / long-term savings report (from an insurance agent or the
pension clearinghouse). Extract it into JSON with exactly this shape:

${SCHEMA}

Rules: numbers are plain numbers (no ₪, commas or %), amounts in ₪. Use only what the report states; null / 0 / [] when it
doesn't say. Every savings product is one entry in "products" (pension funds, managers' insurance, study funds, provident
funds); "summary.totalSavings" must equal the sum of the product balances. Life / health / disability policies that are
not savings products go in "insurance". Keep Hebrew names as written in the report.
Answer with the JSON object only — no text before or after it, no code fence.`;
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // the user's Claude subscription login, not an API key that may be set for other tools
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** Run `claude -p` in a work dir holding only the report; Read is limited to that dir by the data chat's guard hook. */
function extract(dir: string, fileName: string): Promise<string> {
  const guard = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'src', 'agent', 'guard-read.mjs'))} ${JSON.stringify(dir)}`;
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: guard }] }] },
  }));
  const args = ['-p', '--output-format', 'json', '--tools', 'Read', '--setting-sources', 'project', '--strict-mcp-config',
    '--allowedTools', 'Read', '--system-prompt', 'You extract data from documents into JSON, exactly as asked.'];
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, { cwd: dir, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('קריאת הדוח לקחה יותר מ-5 דקות ונעצרה')); }, 5 * 60_000);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`לא הצלחתי להפעיל את Claude Code (claude): ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (result.is_error || code !== 0) {
          const why = String(result.result ?? err);
          // the CLI isn't signed in (or the sign-in expired)
          if (/authenticat|401|log ?in/i.test(why)) return reject(new Error('Claude Code במחשב לא מחובר לחשבון: פתחו Terminal, הקלידו claude, התחברו (/login) ונסו שוב'));
          return reject(new Error(`Claude לא הצליח לקרוא את הדוח: ${why.slice(0, 300)}`));
        }
        resolvePromise(String(result.result ?? ''));
      } catch {
        reject(new Error(`Claude לא החזיר תשובה תקינה${err ? `: ${err.slice(0, 300)}` : ''}`));
      }
    });
    child.stdin.end(prompt(fileName));
  });
}

/** The JSON object in Claude's answer (tolerates a code fence or a stray sentence around it). */
export function parseReport(text: string): Report {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw badRequest('לא נמצאו נתונים בתשובה');
  return JSON.parse(text.slice(start, end + 1));
}

/** Fill what the page reads from the summary, so a report that leaves something out still shows. */
export function normalize(r: Report): Report {
  const s = r.summary ?? {};
  const products = Array.isArray(r.products) ? r.products : [];
  const total = Math.round(products.reduce((sum: number, p: { balance?: number }) => sum + Number(p.balance ?? 0), 0) * 100) / 100;
  return {
    ...r,
    products,
    insurance: Array.isArray(r.insurance) ? r.insurance : [],
    summary: {
      ytdReturnPct: 0, lifeHealthMonthlyPremium: 0, byProductType: [], byProvider: [], tradedPct: { traded: 0, nonTraded: 0 },
      exposurePct: { stocks: 0, abroad: 0, foreignCurrency: 0 }, assetMixPct: [], monthlyDeposits: { total: 0 },
      coverage: { disability: 0, death: 0, noInfo: [] },
      ...s,
      expectedAnnuity: { pensionWithoutDeposits: 0, pensionWithDeposits: 0, managers: 0, totalWithoutDeposits: 0, ...(s.expectedAnnuity ?? {}) },
      totalSavings: total,
    },
    // the report's own total, to warn in the preview when the products don't add up to it
    statedTotal: typeof s.totalSavings === 'number' ? s.totalSavings : null,
  };
}

export function pensionImportRoutes(app: FastifyInstance, db: DB): void {
  // 1. read the file → a draft to preview
  app.post('/api/pension/import/extract', { bodyLimit: 40 * 1024 * 1024 }, async req => {
    const b = req.body as { fileName?: string; memberId?: number; source?: string; contentBase64?: string; text?: string };
    const member = db.prepare(`SELECT id, name FROM members WHERE id = ?`).get(Number(b.memberId)) as { id: number; name: string } | undefined;
    if (!member) throw badRequest('בחרו של מי הדוח');
    if (!b.contentBase64) throw badRequest('לא נבחר קובץ');
    const original = String(b.fileName ?? 'report').replace(/[/\\:]/g, '_').slice(-120);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const fileName = `${stamp}-${original}`;

    // the original goes to data/reports/ (git-ignored) once confirmed; Claude reads a copy in its own work dir
    const dir = join(WORKDIR, randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, fileName), Buffer.from(b.contentBase64, 'base64'));
      // Excel / XML were turned into text in the browser: Claude reads that instead
      const readName = b.text ? `${fileName}.txt` : fileName;
      if (b.text) writeFileSync(join(dir, readName), b.text);
      const report = normalize(parseReport(await extract(dir, readName)));
      if (!report.asOf || !/^\d{4}-\d{2}-\d{2}$/.test(report.asOf)) throw badRequest('לא זוהה תאריך הדוח');
      if (!report.products.length) throw badRequest('לא זוהו מוצרי חיסכון בדוח');
      const id = randomUUID();
      mkdirSync(join(WORKDIR, 'drafts'), { recursive: true });
      cpSync(join(dir, fileName), join(WORKDIR, 'drafts', id));
      drafts.set(id, { report, fileName, memberId: member.id, source: String(b.source ?? 'דוח תקופתי'), createdAt: Date.now() });
      return { draftId: id, member: member.name, report };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2. the user confirmed the preview → import it and keep the file
  app.post('/api/pension/import/confirm', async req => {
    const { draftId } = req.body as { draftId?: string };
    const draft = draftId ? drafts.get(draftId) : undefined;
    if (!draft) throw badRequest('הטיוטה לא נמצאה — קראו את הדוח שוב');
    const member = db.prepare(`SELECT name FROM members WHERE id = ?`).pluck().get(draft.memberId) as string;
    mkdirSync(REPORTS_DIR, { recursive: true });
    const draftFile = join(WORKDIR, 'drafts', draftId!);
    if (existsSync(draftFile)) cpSync(draftFile, join(REPORTS_DIR, draft.fileName));
    const result = importPensionReport(db, { ...draft.report, member, source: draft.source, file: draft.fileName });
    db.prepare(`UPDATE pension_reports SET original_name = ? WHERE as_of = ? AND member_id = ? AND source = ?`)
      .run(draft.fileName.replace(/^\d{8}T\d{6}-/, ''), draft.report.asOf, draft.memberId, draft.source);
    drafts.delete(draftId!);
    rmSync(draftFile, { force: true });
    return result;
  });
}
