import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, LoaderCircle, Sparkles, TriangleAlert, Upload } from 'lucide-react';
import { read, set_cptable, utils } from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { api } from '../api';
import { Modal, Money, MemberSelect } from './ui';
import { fullDate } from '../format';
import { cn } from '@/lib/utils';

set_cptable(cptable);

const SOURCES = ['דוח תקופתי מהסוכן', 'דוח המסלקה הפנסיונית'] as const;
const TYPE_LABELS: Record<string, string> = { pension: 'פנסיה / ביטוח מנהלים', keren_hishtalmut: 'קרן השתלמות', kupat_gemel: 'קופת גמל' };

interface DraftProduct { type: string; name: string; provider: string; balance: number; status: string; employer?: string | null }
interface Draft {
  draftId: string; member: string;
  report: { asOf: string; statedTotal: number | null; summary: { totalSavings: number }; products: DraftProduct[]; insurance: { name: string }[]; agent?: { name: string } | null };
}

/** base64 of a file, for the JSON request. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Excel → CSV text per sheet, XML / CSV → its text; a PDF is read as is (null). */
async function asText(file: File): Promise<string | null> {
  if (/\.pdf$/i.test(file.name)) return null;
  if (/\.(xml|csv|txt)$/i.test(file.name)) return file.text();
  const wb = read(await file.arrayBuffer(), { cellDates: true });
  return wb.SheetNames.map(n => `### ${n}\n${utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
}

/**
 * Import a periodic pension report: pick whose it is and the file, Claude reads it, the user checks the preview and
 * confirms. The report then appears in the page's "imported reports" list.
 */
export function PensionImport({ onClose, defaultMemberId }: { onClose: () => void; defaultMemberId?: number | null }) {
  const qc = useQueryClient();
  const [memberId, setMemberId] = useState<number | null>(defaultMemberId ?? null);
  const [source, setSource] = useState<string>(SOURCES[0]);
  const [file, setFile] = useState<File | null>(null);

  const extract = useMutation({
    mutationFn: async () => api.post<Draft>('/pension/import/extract', {
      fileName: file!.name, memberId, source, contentBase64: await toBase64(file!), text: await asText(file!),
    }),
  });
  const confirm = useMutation({
    mutationFn: () => api.post<{ assets: number; created: number; deposits: number; policies: number }>('/pension/import/confirm', { draftId: extract.data!.draftId }),
    onSuccess: () => { for (const k of ['pension', 'networth', 'assets', 'insurance']) qc.invalidateQueries({ queryKey: [k] }); },
  });

  const draft = extract.data;
  const r = draft?.report;
  const mismatch = r && r.statedTotal != null && Math.abs(r.statedTotal - r.summary.totalSavings) > 2;

  return (
    <Modal wide title="ייבוא דוח פנסיה" onClose={onClose} footer={
      confirm.isSuccess ? <button className="btn btn-primary" onClick={onClose}>סגירה</button>
        : draft ? <>
          <button className="btn" onClick={() => extract.reset()}>קובץ אחר</button>
          <button className="btn btn-primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
            <Upload />{confirm.isPending ? 'מייבא…' : 'ייבא את הדוח'}
          </button>
        </> : <button className="btn btn-primary" disabled={!file || !memberId || extract.isPending} onClick={() => extract.mutate()}>
          {extract.isPending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{extract.isPending ? 'Claude קורא את הדוח… (עד כמה דקות)' : 'קרא את הדוח'}
        </button>
    }>
      {confirm.isSuccess ? (
        <p className="text-sm">
          הדוח יובא ✓ — {confirm.data.assets} מוצרים ({confirm.data.created} חדשים), {confirm.data.deposits} שורות הפקדה
          {confirm.data.policies > 0 && <>, {confirm.data.policies} פוליסות ביטוח</>}. הוא מופיע עכשיו ברשימת ״דוחות שיובאו״ בעמוד.
        </p>
      ) : !draft ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-40"><span className="label">של מי הדוח</span>
              <MemberSelect value={memberId} emptyLabel="בחרו…" onChange={setMemberId} />
            </label>
            <div><span className="label">מאיפה</span>
              <div className="flex gap-1">
                {SOURCES.map(s => <button key={s} type="button" className={cn('btn', source === s && 'btn-primary')} onClick={() => setSource(s)}>{s.replace('דוח ', '')}</button>)}
              </div>
            </div>
            <label className="btn cursor-pointer">
              <FileText />{file?.name ?? 'בחירת קובץ (PDF / Excel / XML)'}
              <input type="file" className="sr-only" accept=".pdf,.xlsx,.xls,.xml,.csv" onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </label>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            כל גוף מסדר את הדוח אחרת, ולכן את הדוח קורא Claude דרך החשבון שלכם — כמו העוזר ✨ באפליקציה. תוכן הקובץ נשלח ל-Claude לקריאה בלבד;
            הוא יכול לפתוח רק את הקובץ הזה. לפני שמשהו נשמר תראו מה זוהה ותאשרו. הקובץ עצמו נשמר במחשב בתיקיית data/reports.
          </p>
          {extract.error && <p className="text-sm text-rose-600">{(extract.error as Error).message}</p>}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            של <b>{draft.member}</b> · נכון ל-<b>{fullDate(r!.asOf)}</b>{r!.agent?.name && <> · הסוכן: {r!.agent.name}</>}
            {' · '}סה״כ <b><Money value={r!.summary.totalSavings} /></b>
          </div>
          {mismatch && (
            <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              המוצרים מסתכמים ב-<Money value={r!.summary.totalSavings} /> אבל בדוח כתוב <Money value={r!.statedTotal} />. כדאי לבדוק מול הדוח לפני הייבוא.</p>
          )}
          <div className="scroll-x"><table className="table">
            <thead><tr><th>מוצר</th><th>סוג</th><th>גוף מנהל</th><th>מצב</th><th className="text-end">יתרה</th></tr></thead>
            <tbody>
              {r!.products.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}{p.employer && <span className="text-xs text-muted-foreground"> · {p.employer}</span>}</td>
                  <td className="whitespace-nowrap">{TYPE_LABELS[p.type] ?? p.type}</td>
                  <td>{p.provider}</td>
                  <td>{p.status === 'active' ? 'פעיל' : 'לא פעיל'}</td>
                  <td className="text-end"><Money value={p.balance} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {r!.insurance.length > 0 && <div className="text-muted-foreground">וגם {r!.insurance.length} פוליסות ביטוח: {r!.insurance.map(i => i.name).join(', ')}</div>}
          <p className="text-xs text-muted-foreground">ייבוא חוזר של אותו דוח מעדכן ולא מכפיל.</p>
          {confirm.error && <p className="text-rose-600">{(confirm.error as Error).message}</p>}
        </div>
      )}
    </Modal>
  );
}
