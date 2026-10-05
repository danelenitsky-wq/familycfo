import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todayIso } from './format';
import { api, type Meta } from './api';

export interface Filters {
  memberId?: number;
  businessId?: number;
  tagIds: number[];
}

interface Ctx {
  filters: Filters;
  setFilters: (f: Filters) => void;
  /** query params shared by every filtered endpoint */
  params: { member?: number; business?: number; tags?: number[] };
}

const FiltersContext = createContext<Ctx | null>(null);

export const PERIOD_OPTIONS = [
  { months: 1, label: 'חודש' }, { months: 3, label: '3 חודשים' }, { months: 6, label: 'חצי שנה' }, { months: 12, label: 'שנה' },
] as const;

/** Key (YYYY-MM of the month it starts in) of the household cycle containing today. */
function currentCycleKey(startDay: number): string {
  const t = todayIso();
  const d = new Date(`${t.slice(0, 7)}-01T12:00:00`);
  if (Number(t.slice(8, 10)) < startDay) d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** The last `n` cycle keys, newest first. */
export function recentCycleKeys(n: number, startDay = 1): string[] {
  const d = new Date(`${currentCycleKey(startDay)}-01T12:00:00`);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d);
    x.setMonth(d.getMonth() - i);
    return x.toISOString().slice(0, 7);
  });
}

interface PeriodCtx {
  /** how many months back the app looks (chosen when updating data) */
  months: number;
  setMonths: (n: number) => void;
  /** the cycles in the period, newest first */
  cycles: string[];
  /** a single cycle, or null for the whole period */
  selected: string | null;
  setSelected: (key: string | null) => void;
  /** the `cycle` query param: the selected cycle, or the whole period as "from..to" */
  cycleParam: string;
}
const PeriodContext = createContext<PeriodCtx | null>(null);

/** The period every page shows: one month of the chosen range, or all of it together. */
export function PeriodProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const months = Number(meta?.settings.view_months) || 3;
  const startDay = Number(meta?.settings.cycle_start_day) || 1;
  // the picked month survives a page reload (per browser; empty = the whole period)
  const [selected, setSelectedState] = useState<string | null>(() => {
    try { return localStorage.getItem('period.selected') || null; } catch { return null; }
  });
  const setSelected = (key: string | null) => {
    setSelectedState(key);
    try { if (key) localStorage.setItem('period.selected', key); else localStorage.removeItem('period.selected'); } catch { /* storage unavailable */ }
  };
  const save = useMutation({
    mutationFn: (n: number) => api.put('/settings', { view_months: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta'] }),
  });
  const value = useMemo(() => {
    const cycles = recentCycleKeys(months, startDay);
    const current = selected && cycles.includes(selected) ? selected : null;
    return {
      months, cycles, selected: current, setSelected,
      setMonths: (n: number) => save.mutate(n),
      cycleParam: current ?? (cycles.length > 1 ? `${cycles[cycles.length - 1]}..${cycles[0]}` : cycles[0]),
    };
  }, [months, startDay, selected, save]);
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodCtx {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod outside PeriodProvider');
  return ctx;
}

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>({ tagIds: [] });
  const value = useMemo(() => ({
    filters, setFilters,
    params: { member: filters.memberId, business: filters.businessId, tags: filters.tagIds },
  }), [filters]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): Ctx {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters outside FiltersProvider');
  return ctx;
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: 60_000 });
}

/** Lookup helpers over meta. */
export function useLookups() {
  const { data } = useMeta();
  return useMemo(() => {
    const members = new Map((data?.members ?? []).map(m => [m.id, m]));
    const accounts = new Map((data?.accounts ?? []).map(a => [a.id, a]));
    const categories = new Map((data?.categories ?? []).map(c => [c.id, c]));
    const businesses = new Map((data?.businesses ?? []).map(b => [b.id, b]));
    const tags = new Map((data?.tags ?? []).map(t => [t.id, t]));
    return {
      meta: data,
      member: (id: number | null | undefined) => (id == null ? undefined : members.get(id)),
      accountName: (id: string | null | undefined) => (id ? accounts.get(id)?.displayName ?? id : '—'),
      category: (id: number | null | undefined) => (id == null ? undefined : categories.get(id)),
      business: (id: number | null | undefined) => (id == null ? undefined : businesses.get(id)),
      tag: (id: number) => tags.get(id),
    };
  }, [data]);
}
