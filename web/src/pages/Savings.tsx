import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Asset, type Fund, type NetWorth, type NetWorthItem } from '../api';
import { useLookups } from '../state';
import { ASSET_TYPE_LABELS, day, moneyIn, todayIso } from '../format';
import {
  Banknote, Bitcoin, Building, ChartCandlestick, CreditCard, DollarSign, Euro, GraduationCap, HandCoins, Home, Landmark, LineChart, Lock,
  type LucideIcon, Package, Pencil, PiggyBank, PoundSterling, Scale, SwissFranc, Target, TrendingUp, Umbrella, Vault, Wallet,
} from 'lucide-react';
import { BreakdownModal, type BreakdownGroup, type BreakdownLine } from '../components/Breakdown';
import { Empty, ErrorBox, Field, Loading, MemberBadge, MemberSelect, Modal, Money, PageHeader, Picker, Progress, SectionTitle, Stat } from '../components/ui';
import { DonutChart, SimpleLine } from '../components/charts';
import { hueFor } from '@/lib/visuals';

const CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'CHF'];
const TYPE_ICONS: Record<string, LucideIcon> = {
  bank_savings: PiggyBank, deposit: Lock, pension: Umbrella, keren_hishtalmut: GraduationCap, kupat_gemel: Vault,
  brokerage: ChartCandlestick, crypto: Bitcoin, real_estate: Building, other: Package,
  bank: Landmark, card: CreditCard, loan: HandCoins, mortgage: Home,
};
const typeIcon = (t: string) => TYPE_ICONS[t] ?? Wallet;
const CURRENCY_ICONS: Record<string, LucideIcon> = { ILS: Banknote, USD: DollarSign, EUR: Euro, GBP: PoundSterling, CHF: SwissFranc };
const ASSET_TYPES = ['bank_savings', 'deposit', 'pension', 'keren_hishtalmut', 'kupat_gemel', 'brokerage', 'crypto', 'real_estate', 'other'];

export default function Savings() {
  const qc = useQueryClient();
  const { meta } = useLookups();
  const nw = useQuery({ queryKey: ['networth'], queryFn: () => api.get<NetWorth>('/networth') });
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => api.get<Asset[]>('/assets') });
  const [editing, setEditing] = useState<Partial<Asset> & { value?: number } | null>(null);
  const [valuing, setValuing] = useState<{ asset: Asset; value: number; date: string } | null>(null);
  // which tile's calculation is open
  const [explain, setExplain] = useState<ExplainKey | null>(null);

  const refresh = () => { for (const k of ['networth', 'assets', 'meta']) qc.invalidateQueries({ queryKey: [k] }); };
  const saveAsset = useMutation({
    mutationFn: async (a: Partial<Asset> & { value?: number }) => {
      const { value, id, ...body } = a;
      const saved = id ? await api.patch<Asset>(`/assets/${id}`, body) : await api.post<Asset>('/assets', body);
      if (value != null && !id) await api.post('/asset-snapshots', { assetId: saved.id, date: todayIso(), value, currency: saved.currency });
    },
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const addSnapshot = useMutation({
    mutationFn: (s: { asset: Asset; value: number; date: string }) =>
      api.post('/asset-snapshots', { assetId: s.asset.id, date: s.date, value: s.value, currency: s.asset.currency }),
    onSuccess: () => { refresh(); setValuing(null); },
  });
  const saveFund = useMutation({
    mutationFn: (f: Partial<Fund> & { id?: number }) => (f.id ? api.patch(`/funds/${f.id}`, f) : api.post('/funds', f)),
    onSuccess: refresh,
  });

  if (nw.isLoading) return <Loading />;
  if (nw.error || !nw.data) return <ErrorBox error={nw.error} />;
  const { totals, items, history } = nw.data;
  const assetItems = items.filter(i => i.group === 'asset');
  const byType = Object.entries(nw.data.byType).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  const typeSlices = byType.filter(([, v]) => v > 0).map(([type, v]) => {
    const Icon = typeIcon(type);
    return { key: type, name: ASSET_TYPE_LABELS[type] ?? type, value: v, icon: <Icon /> };
  });
  const typeNegative = byType.filter(([, v]) => v < 0);
  const nwSpark = history.length > 1 ? history.map(h => h.netWorth) : undefined;

  return (
    <>
      <PageHeader icon={Wallet} title="חסכונות והון" subtitle="כל הכסף של המשפחה במקום אחד — עו״ש, חסכונות, פנסיה, השתלמות, השקעות, פחות חובות"
        actions={<button className="btn btn-primary" onClick={() => setEditing({ type: 'bank_savings', currency: 'ILS' })}>+ נכס חדש</button>} />

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={Scale} label="שווי נקי" value={totals.netWorth} tone={totals.netWorth >= 0 ? 'good' : 'bad'} spark={nwSpark} onClick={() => setExplain('netWorth')} />
        <Stat index={1} icon={TrendingUp} color="var(--chart-5)" label="נכסים" value={totals.assets} onClick={() => setExplain('assets')} />
        <Stat index={2} icon={Landmark} label="התחייבויות" value={totals.liabilities} tone="bad" onClick={() => setExplain('liabilities')} />
        <Stat index={3} icon={Banknote} color="var(--chart-2)" label="נזיל (זמין היום)" value={totals.liquid} hint="עו״ש + חסכונות נזילים, בלי פנסיה ונדל״ן" onClick={() => setExplain('liquid')} />
      </div>

      {explain && (() => {
        const b = explainNetWorth(explain, nw.data!, n => meta?.members.find(m => m.id === n)?.name ?? 'משותף');
        return <BreakdownModal title={b.title} lines={b.lines} groups={b.groups} groupsTitle="לפי סוג" onClose={() => setExplain(null)} />;
      })()}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card min-w-0 lg:col-span-2">
          <SectionTitle icon={LineChart}>שווי נקי לאורך זמן</SectionTitle>
          {history.length > 1 ? <SimpleLine data={history} dataKey="netWorth" formatX={day} height={240} /> : <div className="text-sm text-zinc-500">הגרף יתמלא ככל שיתעדכנו שווי הנכסים והיתרות</div>}
        </div>
        <div className="card min-w-0">
          <SectionTitle icon={Wallet} color="var(--chart-5)">לפי סוג</SectionTitle>
          <DonutChart data={typeSlices} centerLabel="נכסים" height={200} />
          {typeNegative.length > 0 && (
            <div className={`space-y-0.5 text-sm ${typeSlices.length ? 'mt-3 border-t border-line-soft pt-3' : ''}`}>
              {typeNegative.map(([type, v]) => {
                const Icon = typeIcon(type);
                return (
                  <div key={type} className="flex items-center justify-between gap-3 px-2 py-1.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="icon-tile h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5" style={{ ['--tile' as string]: 'var(--negative)' }}><Icon /></span>
                      <span className="truncate">{ASSET_TYPE_LABELS[type] ?? type}</span>
                    </span>
                    <Money value={v} colored />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="card mt-4 p-0">
        <SectionTitle icon={PiggyBank} color="var(--chart-2)">נכסים</SectionTitle>
        {assetItems.length === 0 ? <div className="px-4 pb-4 md:px-5 md:pb-5"><Empty>הוסיפו חסכונות, פנסיה, קרן השתלמות, תיק השקעות ועוד. הערכים מתעדכנים ידנית (ייבוא אוטומטי מהמסלקה הפנסיונית — בשלב 2).</Empty></div> : (
          <div className="scroll-x"><table className="table">
            <thead><tr><th>שם</th><th>סוג</th><th>איפה</th><th>של מי</th><th className="text-end">שווי</th><th className="text-end">בשקלים</th><th>נזיל מ-</th><th>עודכן</th><th /></tr></thead>
            <tbody>
              {assetItems.map(i => {
                const asset = assets.data?.find(a => `asset:${a.id}` === i.id);
                return (
                  <tr key={i.id}>
                    <td className="min-w-40 font-medium">
                      <div className="flex items-center gap-2.5">
                        {(() => { const Icon = typeIcon(i.type); return <span className="icon-tile h-8 w-8" style={{ ['--tile' as string]: hueFor(i.type) }}><Icon /></span>; })()}
                        <div className="min-w-0">{i.name}{asset?.notes && <div className="text-xs font-normal text-zinc-500">{asset.notes}</div>}</div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{ASSET_TYPE_LABELS[i.type] ?? i.type}</td>
                    <td className="text-sm">{i.provider}{asset?.managementFee && <div className="text-xs text-zinc-500">דמי ניהול {asset.managementFee}</div>}</td>
                    <td><MemberBadge id={i.ownerMemberId} /></td>
                    <td className="num whitespace-nowrap text-end">{moneyIn(i.value, i.currency)}</td>
                    <td className="text-end"><Money value={i.valueIls} /></td>
                    <td className="whitespace-nowrap text-xs">{i.liquidityDate ? day(i.liquidityDate) : 'נזיל'}</td>
                    <td className="whitespace-nowrap text-xs text-zinc-500">{day(i.asOf)}</td>
                    <td className="whitespace-nowrap">
                      {i.id.startsWith('portfolio:') && <Link className="btn-ghost" to="/investments">לתיק ההשקעות</Link>}
                      {asset && <>
                        <button className="btn-ghost" onClick={() => setValuing({ asset, value: i.value, date: todayIso() })}>עדכן שווי</button>
                        <button className="btn-ghost btn-icon" aria-label="עריכה" onClick={() => setEditing(asset)}><Pencil /></button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="card mt-4">
        <SectionTitle icon={Target} color="var(--chart-6)" action={<button className="btn" onClick={() => saveFund.mutate({ name: `קופה ${(meta?.funds.length ?? 0) + 1}`, monthlyTarget: 0 })}>+ קופה</button>}>
          <span>קופות חיסכון ויעדים (חופשה, חיסכון, הוצאות חריגות)</span>
        </SectionTitle>
        <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {meta?.funds.map((f, idx) => (
            <div key={f.id} style={{ ['--i' as string]: idx }} className="card-hover min-w-0 rounded-lg border border-line bg-surface-muted p-3 focus-within:border-brand-300 dark:focus-within:border-brand-700">
              <div className="mb-3 flex items-center gap-2.5">
                <span className="icon-tile h-9 w-9" style={{ ['--tile' as string]: hueFor(f.name) }}><PiggyBank /></span>
                <input className="input min-w-0 flex-1 font-medium" defaultValue={f.name} onBlur={e => e.target.value !== f.name && saveFund.mutate({ id: f.id, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-3">
                <Field label="יעד חודשי"><input className="input num" type="number" defaultValue={f.monthlyTarget}
                  onBlur={e => Number(e.target.value) !== f.monthlyTarget && saveFund.mutate({ id: f.id, monthlyTarget: Number(e.target.value) })} /></Field>
                <Field label="יתרה בקופה"><input className="input num" type="number" defaultValue={f.balance}
                  onBlur={e => Number(e.target.value) !== f.balance && saveFund.mutate({ id: f.id, balance: Number(e.target.value) })} /></Field>
                <Field label="מטרה (₪)"><input className="input num" type="number" defaultValue={f.goalAmount ?? ''}
                  onBlur={e => saveFund.mutate({ id: f.id, goalAmount: e.target.value ? Number(e.target.value) : null })} /></Field>
                <Field label="עד תאריך"><input className="input" type="date" defaultValue={f.goalDate ?? ''}
                  onBlur={e => saveFund.mutate({ id: f.id, goalDate: e.target.value || null })} /></Field>
              </div>
              {f.goalAmount ? (
                <div className="mt-3 text-xs text-zinc-500">
                  <Progress className="mb-1.5" value={f.balance} max={f.goalAmount} />
                  {Math.round((f.balance / f.goalAmount) * 100)}% מהמטרה
                  {f.goalDate && (() => {
                    const months = Math.max(1, Math.round((Date.parse(f.goalDate) - Date.now()) / (30.4 * 86_400_000)));
                    return <> · צריך <Money value={Math.max(0, (f.goalAmount - f.balance) / months)} /> בחודש</>;
                  })()}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <Modal title={editing.id ? 'עריכת נכס' : 'נכס חדש'} onClose={() => setEditing(null)} footer={<>
          <button className="btn" onClick={() => setEditing(null)}>ביטול</button>
          {editing.id && <button className="btn" onClick={() => saveAsset.mutate({ id: editing.id, archived: 1 })}>ארכיון</button>}
          <button className="btn btn-primary" disabled={!editing.name} onClick={() => saveAsset.mutate(editing)}>שמור</button>
        </>}>
          <Field label="שם"><input className="input" value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="למשל: קרן השתלמות — אלטשולר" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="סוג"><Picker value={editing.type} onChange={v => v && setEditing({ ...editing, type: v })}
              options={ASSET_TYPES.map(t => { const Icon = typeIcon(t); return { value: t, label: ASSET_TYPE_LABELS[t], icon: <Icon /> }; })} /></Field>
            <Field label="איפה (גוף מנהל / בנק / ברוקר)"><input className="input" value={editing.provider ?? ''} onChange={e => setEditing({ ...editing, provider: e.target.value })} /></Field>
            <Field label="של מי"><MemberSelect value={editing.ownerMemberId} emptyLabel="משותף" onChange={id => setEditing({ ...editing, ownerMemberId: id })} /></Field>
            <Field label="מטבע"><Picker value={editing.currency} onChange={v => v && setEditing({ ...editing, currency: v })}
              options={CURRENCIES.map(c => { const Icon = CURRENCY_ICONS[c] ?? Banknote; return { value: c, label: c, icon: <Icon /> }; })} /></Field>
            {!editing.id && <Field label="שווי נוכחי"><input className="input num" type="number" value={editing.value ?? ''} onChange={e => setEditing({ ...editing, value: Number(e.target.value) })} /></Field>}
            <Field label="נזיל מתאריך"><input className="input" type="date" value={editing.liquidityDate ?? ''} onChange={e => setEditing({ ...editing, liquidityDate: e.target.value })} /></Field>
            <Field label="דמי ניהול"><input className="input" value={editing.managementFee ?? ''} onChange={e => setEditing({ ...editing, managementFee: e.target.value })} placeholder="0.5% מצבירה" /></Field>
            <Field label="הפקדה חודשית"><input className="input num" type="number" value={editing.monthlyDeposit ?? ''} onChange={e => setEditing({ ...editing, monthlyDeposit: Number(e.target.value) })} /></Field>
          </div>
          <Field label="הערות"><textarea className="input" rows={2} value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></Field>
        </Modal>
      )}

      {valuing && (
        <Modal title={`עדכון שווי — ${valuing.asset.name}`} onClose={() => setValuing(null)} footer={<>
          <button className="btn" onClick={() => setValuing(null)}>ביטול</button>
          <button className="btn btn-primary" onClick={() => addSnapshot.mutate(valuing)}>שמור</button>
        </>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`שווי (${valuing.asset.currency})`}><input className="input num" type="number" value={valuing.value} onChange={e => setValuing({ ...valuing, value: Number(e.target.value) })} /></Field>
            <Field label="נכון לתאריך"><input className="input" type="date" value={valuing.date} onChange={e => setValuing({ ...valuing, date: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

type ExplainKey = 'netWorth' | 'assets' | 'liabilities' | 'liquid';

/** The items behind a net-worth tile, grouped by type, each group opening to its items. */
function explainNetWorth(which: ExplainKey, data: NetWorth, ownerName: (id: number | null) => string):
  { title: string; lines: BreakdownLine[]; groups: BreakdownGroup[] } {
  const { items, totals } = data;
  const groupBy = (list: NetWorthItem[]): BreakdownGroup[] => {
    const groups = new Map<string, BreakdownGroup>();
    for (const i of list) {
      const name = ASSET_TYPE_LABELS[i.type] ?? ASSET_TYPE_LABELS[i.group] ?? i.type;
      const g = groups.get(name) ?? { name, amount: 0, rows: [] };
      g.amount += i.valueIls;
      g.rows!.push({ id: i.id, date: i.asOf ?? undefined, description: i.provider && !i.name.includes(i.provider) ? `${i.name} · ${i.provider}` : i.name,
        account: ownerName(i.ownerMemberId), amount: i.valueIls,
        note: i.currency !== 'ILS' ? `${i.value.toLocaleString('he-IL')} ${i.currency}` : i.liquidityDate && i.group === 'asset' ? `נזיל מ-${i.liquidityDate}` : undefined });
      groups.set(name, g);
    }
    return [...groups.values()].map(g => ({ ...g, amount: Math.round(g.amount) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  };
  const positive = items.filter(i => i.valueIls > 0);
  const negative = items.filter(i => i.valueIls < 0);
  if (which === 'netWorth') return {
    title: 'שווי נקי — איך זה חושב',
    lines: [
      { label: `נכסים (${positive.length})`, amount: totals.assets },
      { label: `פחות: התחייבויות (${negative.length})`, amount: totals.liabilities, note: 'הלוואות, משכנתא, חיובי כרטיס שעוד לא ירדו ויתרות שליליות' },
      { label: 'שווי נקי', amount: totals.netWorth, total: true },
    ],
    groups: groupBy(items.filter(i => i.valueIls !== 0)),
  };
  if (which === 'assets') return {
    title: 'נכסים — איך זה חושב',
    lines: [{ label: 'כל מה ששווה כסף: עו״ש ביתרת זכות, חסכונות, פנסיה, השתלמות, השקעות, נדל״ן', amount: totals.assets, total: true }],
    groups: groupBy(positive),
  };
  if (which === 'liabilities') return {
    title: 'התחייבויות — איך זה חושב',
    lines: [{ label: 'הלוואות ומשכנתא (יתרה לסילוק), חיובי כרטיס שעוד לא ירדו מהבנק, ועו״ש ביתרת חובה', amount: totals.liabilities, total: true }],
    groups: groupBy(negative),
  };
  const liquid = items.filter(i => i.liquid);
  const locked = items.filter(i => i.group === 'asset' && !i.liquid && i.valueIls > 0);
  return {
    title: 'נזיל (זמין היום) — איך זה חושב',
    lines: [
      { label: 'נזיל: עו״ש וחסכונות שאפשר למשוך היום', amount: totals.liquid, total: true },
      { label: `לא נספר: חסכונות שאינם נזילים (${locked.length})`, amount: Math.round(locked.reduce((s, i) => s + i.valueIls, 0)),
        note: 'פנסיה, נדל״ן, קופת גמל, וקרן השתלמות / פיקדון לפני מועד הנזילות' },
    ],
    groups: groupBy(liquid.filter(i => i.valueIls !== 0)),
  };
}
