import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, FileUp, KeyRound, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type ScrapeJob } from '../api';
import { Popover, PopoverContent, PopoverTrigger } from './kit/popover';
import { Modal } from './ui';
import { PERIOD_OPTIONS, useMeta, usePeriod } from '../state';
import { cn } from '@/lib/utils';

export const COMPANY_LABELS: Record<string, string> = {
  hapoalim: 'בנק הפועלים', leumi: 'בנק לאומי', discount: 'דיסקונט', mizrahi: 'מזרחי טפחות', beinleumi: 'הבינלאומי',
  mercantile: 'מרכנתיל', otsarHahayal: 'אוצר החייל', yahav: 'יהב', massad: 'מסד', union: 'איגוד', oneZero: 'One Zero',
  isracard: 'ישראכרט', amex: 'אמריקן אקספרס', max: 'מקס', visaCal: 'כאל', behatsdaa: 'בהצדעה', beyahadBishvilha: 'ביחד בשבילך',
};
const companyName = (id: string) => COMPANY_LABELS[id] ?? id;

const rtf = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
function ago(utc: string): string {
  const minutes = (Date.parse(`${utc.replace(' ', 'T')}${utc.endsWith('Z') ? '' : 'Z'}`) - Date.now()) / 60000;
  if (minutes > -1) return 'עכשיו';
  if (minutes > -60) return rtf.format(Math.round(minutes), 'minute');
  if (minutes > -60 * 24) return rtf.format(Math.round(minutes / 60), 'hour');
  return rtf.format(Math.round(minutes / 60 / 24), 'day');
}

const active = (s: ScrapeJob['status'] | undefined) => s === 'running' || s === 'pipeline';

/** Header button that scrapes all banks from the UI, shows progress and asks for the bank's OTP code. */
export function ScrapeButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  // asking how many months back to fetch before a scrape starts
  const [choosing, setChoosing] = useState(false);
  const period = usePeriod();
  // whose data to update: null = everyone
  const [whose, setWhose] = useState<number | null>(null);
  const { data: meta } = useMeta();
  const logins = useQuery({ queryKey: ['setup-logins'], enabled: choosing,
    queryFn: () => api.get<{ logins: { companyId: string; ownerMemberId: number | null; filled: Record<string, boolean> }[] }>('/setup/logins') });
  const SHARED = 3;
  const people = (meta?.members ?? []).filter(m => m.id !== SHARED);
  const chosen = whose == null ? (meta?.members ?? []).map(m => m.id) : [whose];
  const connected = (logins.data?.logins ?? []).filter(l => Object.values(l.filled).every(Boolean) && chosen.includes(l.ownerMemberId ?? SHARED));
  // accounts of the chosen people that no direct login of theirs covers: they come from uploaded files
  const uploaded = (meta?.accounts ?? []).filter(a => (a.kind === 'bank' || a.kind === 'card') && chosen.includes(a.ownerMemberId ?? SHARED)
    && !connected.some(l => l.companyId === a.company && (l.ownerMemberId ?? SHARED) === (a.ownerMemberId ?? SHARED)));
  const job = useQuery({
    queryKey: ['scrape'],
    queryFn: () => api.get<ScrapeJob>('/scrape'),
    refetchInterval: q => (active(q.state.data?.status) ? 1000 : 60_000),
  });
  const data = job.data;
  const running = active(data?.status);

  const start = useMutation({
    mutationFn: (months: number) => api.post<ScrapeJob>('/scrape', { months, memberIds: whose == null ? undefined : [whose] }),
    onSuccess: () => {
      setChoosing(false); setOpen(true); period.setSelected(null);
      qc.invalidateQueries({ queryKey: ['scrape'] }); qc.invalidateQueries({ queryKey: ['meta'] });
    },
  });
  const sendOtp = useMutation({
    mutationFn: () => api.post('/scrape/otp', { code }),
    onSuccess: () => { setCode(''); qc.invalidateQueries({ queryKey: ['scrape'] }); },
  });

  // the bank asks for a code: open the panel so it's not missed
  const otpCompany = data?.otp?.company;
  useEffect(() => { if (otpCompany) setOpen(true); }, [otpCompany]);

  // finished: everything on screen is stale — refetch it
  const prev = useRef(data?.status);
  useEffect(() => {
    if (active(prev.current) && data && !active(data.status)) qc.invalidateQueries({ predicate: q => q.queryKey[0] !== 'scrape' });
    prev.current = data?.status;
  }, [data, qc]);

  const label = data?.otp ? 'נדרש קוד אימות' : data?.status === 'pipeline' ? 'מעבד נתונים…' : running ? 'מעדכן…' : 'עדכון נתונים';

  return (
    <div className="flex flex-col items-end gap-1">
      {choosing && (
        <Modal title="עדכון נתונים" onClose={() => setChoosing(false)}>
          <div className="mb-2 text-sm font-semibold">של מי לעדכן?</div>
          <div className="mb-4 flex flex-wrap gap-2">
            {people.map(m => (
              <button key={m.id} type="button" className={cn('btn', whose === m.id && 'btn-primary')} onClick={() => setWhose(m.id)}>{m.name}</button>
            ))}
            <button type="button" className={cn('btn', whose == null && 'btn-primary')} onClick={() => setWhose(null)}>
              {people.length === 2 ? `${people[0].name} ו${people[1].name}` : 'כולם'}
            </button>
          </div>
          {logins.data && (
            <div className="mb-4 space-y-2 text-sm">
              {connected.length > 0
                ? <p>בחיבור ישיר: {[...new Set(connected.map(l => companyName(l.companyId)))].join(', ')}</p>
                : <p className="text-amber-700 dark:text-amber-400">אין חשבונות בחיבור ישיר למי שנבחר — את הנתונים מעדכנים בהעלאת קובץ.
                    {uploaded.length === 0 && <> <Link to="/import" className="underline" onClick={() => setChoosing(false)}>להעלאת קובץ</Link></>}</p>}
              {uploaded.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-2.5 dark:bg-amber-500/10">
                  <div>חשבונות שמתעדכנים בהעלאת קובץ (הכפתור לא יכול להוריד אותם מהבנק):</div>
                  <div className="mt-1 text-muted-foreground">{uploaded.map(a => a.displayName ?? a.id).join(' · ')}</div>
                  <Link to="/import" className="btn mt-2" onClick={() => setChoosing(false)}><FileUp />להעלאת קובץ חדש</Link>
                </div>
              )}
            </div>
          )}
          <div className="mb-2 text-sm font-semibold">לכמה זמן אחורה?</div>
          <div className="grid grid-cols-2 gap-2">
            {PERIOD_OPTIONS.map(o => (
              <button key={o.months} type="button" disabled={start.isPending || (!!logins.data && connected.length === 0)}
                className={cn('btn h-14 justify-center text-base', o.months === period.months && 'btn-primary')}
                onClick={() => start.mutate(o.months)}>
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">זו גם התקופה שתוצג בכל המסכים. אחר כך אפשר לבחור למעלה חודש מסוים או את כל התקופה ביחד.</p>
          {start.error && <p className="mt-2 text-sm text-red-600">{(start.error as Error).message}</p>}
        </Modal>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn('btn', data?.otp ? 'border-amber-400 text-amber-700 dark:text-amber-300 animate-pulse' : !running && 'btn-primary')}
            onClick={e => { if (!running && !data?.otp) { e.preventDefault(); setChoosing(true); } }}
            disabled={start.isPending}>
            {data?.otp ? <KeyRound /> : <RefreshCw className={cn(running && 'animate-spin')} />}
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-80 max-w-[calc(100vw-1.5rem)] p-0" dir="rtl">
          <div className="border-b px-4 py-3 text-sm font-semibold">
            {running ? 'מעדכן נתונים מהבנקים' : data?.status === 'failed' ? 'העדכון לא הצליח' : 'העדכון הסתיים'}
          </div>
          {data?.otp && (
            <form className="space-y-2 border-b bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10"
              onSubmit={e => { e.preventDefault(); if (code) sendOtp.mutate(); }}>
              <label className="block text-sm" htmlFor="scrape-otp">
                {companyName(data.otp.company)} שלח קוד אימות ב-SMS. הקלד אותו כאן:
              </label>
              <div className="flex gap-2">
                <input id="scrape-otp" className="input flex-1 text-center tracking-[0.4em]" dir="ltr" inputMode="numeric"
                  autoComplete="one-time-code" maxLength={8} autoFocus value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
                <button type="submit" className="btn btn-primary" disabled={code.length < 4 || sendOtp.isPending}>שליחה</button>
              </div>
              {sendOtp.error && <div className="text-xs text-red-600">{(sendOtp.error as Error).message}</div>}
            </form>
          )}
          <ul className="divide-y text-sm">
            {data?.companies.map(c => (
              <li key={c.company} className="flex items-start gap-2.5 px-4 py-2.5">
                <span className="mt-0.5 shrink-0">
                  {c.status === 'running' ? <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                    : c.status === 'done' ? <Check className="h-4 w-4 text-emerald-600" />
                    : c.status === 'failed' ? <X className="h-4 w-4 text-red-600" />
                    : <Circle className="h-4 w-4 text-zinc-300" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className={cn(c.status === 'pending' && 'text-muted-foreground')}>{companyName(c.company)}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.status === 'running' ? (data.otp?.company === c.company ? 'ממתין לקוד' : 'בתהליך')
                        : c.status === 'done' ? (c.newTransactions ? `${c.newTransactions} חדשות` : 'אין חדשות')
                        : c.status === 'failed' ? 'נכשל' : 'בתור'}
                    </span>
                  </div>
                  {c.error && <div className="mt-0.5 line-clamp-2 text-xs text-red-600" title={c.error} dir="auto">{c.error}</div>}
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            {data?.status === 'pipeline' ? 'מסווג תנועות ומעדכן חישובים…'
              : data?.status === 'done' ? `הסתיים · נוספו ${data.newTransactions} תנועות חדשות`
              : data?.status === 'failed' ? (data.error ?? 'שגיאה')
              : running ? 'חלון דפדפן ייפתח לכל בנק — אפשר להמשיך לעבוד בינתיים' : null}
          </div>
        </PopoverContent>
      </Popover>
      {start.error && <span className="text-xs text-red-600">{(start.error as Error).message}</span>}
      {!running && data?.lastSuccessAt && <span className="text-xs text-muted-foreground">עודכן {ago(data.lastSuccessAt)}</span>}
    </div>
  );
}
