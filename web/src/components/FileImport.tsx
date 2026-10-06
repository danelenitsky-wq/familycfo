import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Plus, Trash2, Upload } from 'lucide-react';
import { read, set_cptable, utils } from 'xlsx';
// Hebrew code pages (windows-1255) for old .xls files and CSVs saved from Excel
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { api } from '../api';
import { MemberSelect, Money } from './ui';
import { useLookups } from '../state';
import { COMPANY_LABELS } from './ScrapeButton';
import { FIELD_LABELS, findHeader, latestBalance, toTransactions, type Cell, type Field, type Mapping } from '../lib/statement';
import { day, money } from '../format';

interface Company { id: string; name: string; kind: 'bank' | 'card' }
interface ImportResult { accountId: string; rows: number; inserted: number; updated: number }

set_cptable(cptable);

/** Excel files carry their own encoding; a CSV is UTF-8 or (saved from Hebrew Excel) windows-1255. */
async function readWorkbook(file: File) {
  const buf = await file.arrayBuffer();
  // real Excel files: .xlsx is a zip ("PK"), old .xls a compound file (D0 CF 11 E0)
  const head = new Uint8Array(buf.slice(0, 4));
  const binary = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0);
  if (binary) return read(buf, { cellDates: true });
  // anything else is text: a CSV, or an HTML table saved as ".xls" (Leumi, Hapoalim and others export that way)
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1255').decode(buf); }
  text = text.replace(/^\uFEFF/, '').trimStart();
  // raw: keep "05/10/2026" as text so it is read day-first, not as a US date
  return read(text, { type: 'string', raw: true });
}

const FIELDS: Field[] = ['date', 'description', 'amount', 'debit', 'credit', 'processedDate', 'originalAmount', 'currency', 'memo', 'installments', 'balance'];

interface EntryInit { key: number; companyId: string; label: string; ownerMemberId: number | null }
let nextKey = 1;

/**
 * Upload statement files (Excel / CSV exported from the bank's or card company's website) instead of
 * connecting the accounts: one entry per bank account or card. Accounts uploaded before are listed
 * again, ready for next month's file. The file is read here in the browser; only the parsed rows go to
 * the local API.
 */
export function FileImport() {
  const { meta } = useLookups();
  const logins = useQuery({ queryKey: ['setup-logins'], queryFn: () => api.get<{ logins: { companyId: string; ownerMemberId: number | null; filled: Record<string, boolean> }[] }>('/setup/logins') });
  const history = useQuery({ queryKey: ['import-history'], queryFn: () => api.get<UploadRecord[]>('/import/history') });
  const [entries, setEntries] = useState<EntryInit[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !meta || !logins.data || !history.data) return;
    started.current = true;
    // accounts that files were uploaded to, plus accounts no filled-in login of the same owner covers
    const SHARED = 3;
    const connected = new Set(logins.data.logins.filter(l => Object.values(l.filled).every(Boolean)).map(l => `${l.companyId}|${l.ownerMemberId ?? SHARED}`));
    const fromUploads = new Set(history.data.map(u => u.accountId));
    const uploaded = meta.accounts.filter(a => (a.kind === 'bank' || a.kind === 'card')
      && (fromUploads.has(a.id) || !connected.has(`${a.company}|${a.ownerMemberId ?? SHARED}`)))
      .map(a => ({ key: nextKey++, companyId: a.company, label: a.id.slice(a.company.length + 1), ownerMemberId: a.ownerMemberId }));
    setEntries(uploaded.length ? uploaded : [{ key: nextKey++, companyId: 'max', label: '', ownerMemberId: null }]);
  }, [meta, logins.data, history.data]);

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-500">
        היכנסו לאתר הבנק או חברת האשראי, הורידו את פירוט התנועות כקובץ אקסל או CSV, ובחרו אותו כאן. הקובץ נקרא בתוך המחשב שלכם בלבד.
        העלאה חוזרת של אותו קובץ לא יוצרת כפילויות — אפשר להעלות כל חודש קובץ חדש.
      </p>
      {entries.map(e => (
        <UploadEntry key={e.key} initial={e} onRemove={() => setEntries(es => es.filter(x => x.key !== e.key))} />
      ))}
      <button className="btn" onClick={() => setEntries(es => [...es, { key: nextKey++, companyId: 'max', label: '', ownerMemberId: null }])}>
        <Plus />הוסף בנק או כרטיס
      </button>
    </div>
  );
}

/** One bank account or card: its details, a file, the column mapping and a preview. */
function UploadEntry({ initial, onRemove }: { initial: EntryInit; onRemove: () => void }) {
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['setup-companies'], queryFn: () => api.get<Company[]>('/setup/companies') });
  const [companyId, setCompanyId] = useState(initial.companyId);
  const [label, setLabel] = useState(initial.label);
  const [ownerMemberId, setOwnerMemberId] = useState<number | null>(initial.ownerMemberId);
  const [balance, setBalance] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Cell[][]>([]);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [expensesPositive, setExpensesPositive] = useState(true);
  const [error, setError] = useState('');

  const kind = companies.data?.find(c => c.id === companyId)?.kind ?? 'card';
  const parsed = rows.length ? toTransactions(rows, headerIndex, mapping, expensesPositive) : null;
  // a bank statement's running balance gives the account's current balance (unless typed in)
  const fileBalance = kind === 'bank' && parsed ? latestBalance(parsed.rows) : null;

  async function onFile(file: File | undefined) {
    setError(''); setRows([]); upload.reset();
    if (!file) return;
    setFileName(file.name);
    try {
      const wb = await readWorkbook(file);
      // the sheet with the most rows is the statement (some exports add a summary sheet)
      const sheets = wb.SheetNames.map(n => utils.sheet_to_json<Cell[]>(wb.Sheets[n], { header: 1, raw: true, defval: null }));
      const all = sheets.sort((a, b) => b.length - a.length)[0] ?? [];
      const header = findHeader(all);
      setRows(all);
      if (header) { setHeaderIndex(header.index); setMapping(header.mapping); }
      else { setHeaderIndex(0); setMapping({}); setError('לא זיהיתי את הכותרות אוטומטית — בחרו למטה איזו עמודה היא מה.'); }
      // a separate debit/credit pair already carries the sign; a single column on a card statement is purchases-positive
      setExpensesPositive(kind === 'card');
    } catch (e) {
      setError(`לא הצלחתי לקרוא את הקובץ: ${(e as Error).message}`);
    }
  }

  const upload = useMutation({
    mutationFn: () => api.post<ImportResult>('/import', {
      companyId, accountLabel: label, ownerMemberId, balance: balance.trim() ? Number(balance) : fileBalance, fileName, rows: parsed!.rows,
    }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const header = rows[headerIndex] ?? [];
  const columns = header.map((c, i) => ({ i, name: c == null || c === '' ? `עמודה ${i + 1}` : String(c) }));
  const banks = (companies.data ?? []).filter(c => c.kind === 'bank');
  const cards = (companies.data ?? []).filter(c => c.kind === 'card');

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-44"><span className="label">בנק / כרטיס</span>
          <select className="input" value={companyId} onChange={e => setCompanyId(e.target.value)}>
            <optgroup label="בנקים">{banks.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
            <optgroup label="כרטיסי אשראי">{cards.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
          </select>
        </label>
        <label className="min-w-40"><span className="label">{kind === 'bank' ? 'מספר חשבון (או כינוי)' : '4 ספרות אחרונות של הכרטיס'}</span>
          <input className="input" dir="ltr" value={label} onChange={e => setLabel(e.target.value)} placeholder={kind === 'bank' ? '12-345-678901' : '1234'} />
        </label>
        <label className="min-w-36"><span className="label">של מי</span>
          <MemberSelect value={ownerMemberId} emptyLabel="משותף" onChange={setOwnerMemberId} />
        </label>
        {kind === 'bank' && (
          <label className="w-40"><span className="label">יתרה נוכחית (לא חובה)</span>
            <input className="input num" type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)}
              placeholder={fileBalance != null ? `${fileBalance} (מהקובץ)` : ''} />
          </label>
        )}
        <label className="btn cursor-pointer">
          <FileSpreadsheet />{fileName || 'בחירת קובץ'}
          <input type="file" className="sr-only" accept=".xlsx,.xls,.csv" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <button className="btn-ghost btn-icon ms-auto text-rose-600" aria-label="הסר מהרשימה" title="הסר מהרשימה (התנועות שכבר הועלו נשארות)" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <UploadHistory accountId={`${companyId}:${label.trim().replace(/[:\s]+/g, '-')}`} />

      {error && <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>}

      {rows.length > 0 && (
        <div className="space-y-3 border-t border-line-soft pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-28"><span className="label">שורת כותרות</span>
              <input className="input num" type="number" min={1} max={rows.length} value={headerIndex + 1}
                onChange={e => setHeaderIndex(Math.max(0, Math.min(rows.length - 1, Number(e.target.value) - 1)))} />
            </label>
            {FIELDS.map(f => (
              <label key={f} className="min-w-32"><span className="label">{FIELD_LABELS[f]}</span>
                <select className="input py-1" value={mapping[f] ?? ''}
                  onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value === '') delete n[f]; else n[f] = Number(e.target.value); return n; })}>
                  <option value="">—</option>
                  {columns.map(c => <option key={c.i} value={c.i}>{c.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          {mapping.amount != null && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={expensesPositive} onChange={e => setExpensesPositive(e.target.checked)} />
              בקובץ הזה הוצאות מופיעות כמספר חיובי (רגיל בפירוט כרטיס אשראי)
            </label>
          )}

          {parsed && parsed.rows.length > 0 ? (
            <>
              <div className="text-sm">
                נמצאו <b className="num">{parsed.rows.length}</b> תנועות
                {parsed.skipped > 0 && <span className="text-zinc-500"> · {parsed.skipped} שורות דולגו (סיכומים / שורות ריקות)</span>}
                {' · '}הוצאות {money(-parsed.rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0))}
                {' · '}הכנסות {money(parsed.rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0))}
              </div>
              <div className="scroll-x card-bleed max-h-72 overflow-y-auto"><table className="table">
                <thead><tr><th>תאריך</th><th>תיאור</th><th className="text-end">סכום</th><th>חיוב</th><th>תשלומים</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="num whitespace-nowrap text-xs">{r.date}</td>
                      <td>{r.description}</td>
                      <td className={`num text-end ${r.amount < 0 ? '' : 'text-emerald-600'}`}>{money(r.amount)}{r.currency && r.currency !== 'ILS' ? ` (${r.currency})` : ''}</td>
                      <td className="num whitespace-nowrap text-xs">{r.processedDate ?? ''}</td>
                      <td className="num text-xs">{r.installmentTotal ? `${r.installmentNumber}/${r.installmentTotal}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              {parsed.rows.length > 50 && <div className="text-xs text-zinc-500">מוצגות 50 הראשונות</div>}
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-primary" disabled={!label.trim() || upload.isPending} onClick={() => upload.mutate()}>
                  <Upload />{upload.isPending ? 'מעלה ומסווג…' : `העלה ${parsed.rows.length} תנועות`}
                </button>
                {!label.trim() && <span className="text-sm text-amber-700 dark:text-amber-400">מלאו מספר חשבון / 4 ספרות כדי לזהות את החשבון</span>}
                {upload.data && <span className="text-sm text-emerald-700 dark:text-emerald-400">נוספו {upload.data.inserted} תנועות חדשות{upload.data.rows - upload.data.inserted > 0 ? ` (${upload.data.rows - upload.data.inserted} כבר היו)` : ''} ✓</span>}
                {upload.error && <span className="text-sm text-rose-600">{(upload.error as Error).message}</span>}
              </div>
            </>
          ) : <p className="text-sm text-zinc-500">לא נמצאו תנועות — בדקו את שורת הכותרות ואת בחירת העמודות.</p>}
        </div>
      )}
    </div>
  );
}

interface UploadRecord {
  id: number; accountId: string; accountName: string | null; fileName: string | null; uploadedAt: string;
  rows: number; inserted: number; fromDate: string | null; toDate: string | null; balance: number | null;
}

/** The files uploaded to one account so far (kept in the database), newest first. */
function UploadHistory({ accountId }: { accountId: string }) {
  const history = useQuery({ queryKey: ['import-history'], queryFn: () => api.get<UploadRecord[]>('/import/history') });
  const mine = (history.data ?? []).filter(u => u.accountId === accountId);
  if (!mine.length) return null;
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
      <div className="mb-1 font-semibold">קבצים שהועלו לחשבון הזה</div>
      <ul className="space-y-0.5">
        {mine.map(u => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <FileSpreadsheet className="h-3.5 w-3.5" />
            <span className="text-foreground">{u.fileName ?? 'קובץ'}</span>
            <span>· הועלה {uploadedAt(u.uploadedAt)}</span>
            {u.fromDate && u.toDate && <span>· תנועות {day(u.fromDate)} – {day(u.toDate)}</span>}
            <span>· {u.rows} תנועות{u.inserted < u.rows ? ` (${u.inserted} חדשות)` : ''}</span>
            {u.balance != null && <span>· יתרה <Money value={u.balance} /></span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "2026-10-06 10:31:03" (UTC, from SQLite) → local date and time. */
function uploadedAt(utc: string): string {
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  return d.toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
