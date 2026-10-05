import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Modal, Money } from './ui';
import { day } from '../format';
import { cn } from '@/lib/utils';

export interface BreakdownLine { label: string; amount: number; note?: string; total?: boolean }
export interface BreakdownRow { id?: number | string; date?: string; description: string; account?: string; amount: number; note?: string }
export interface BreakdownGroup { name: string; amount: number; note?: string; rows?: BreakdownRow[] }

/**
 * How a number on a stat tile was calculated: the calculation lines (what was added, subtracted and
 * left out), then what it is made of — groups that open to their rows.
 */
export function BreakdownModal({ title, lines, groups, groupsTitle = 'ממה זה מורכב', onClose }: {
  title: string; lines: BreakdownLine[]; groups: BreakdownGroup[]; groupsTitle?: string; onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = lines.filter(l => l.total || l.amount !== 0);
  return (
    <Modal wide title={title} onClose={onClose}>
      {shown.length > 0 && (
        <div className="mb-4 rounded-lg border border-line-soft">
          {shown.map((l, i) => (
            <div key={i} className={cn('flex items-baseline justify-between gap-4 px-3 py-2 text-sm', i > 0 && 'border-t border-line-soft', l.total && 'bg-muted/50 font-semibold')}>
              <div>
                <div>{l.label}</div>
                {l.note && <div className="text-xs font-normal text-muted-foreground">{l.note}</div>}
              </div>
              <Money value={l.amount} />
            </div>
          ))}
        </div>
      )}
      {groups.length > 0 && <>
        <div className="mb-2 text-sm font-semibold">{groupsTitle}</div>
        <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
          {groups.map(g => {
            const isOpen = open === g.name;
            const hasRows = !!g.rows?.length;
            return (
              <li key={g.name}>
                <button type="button" disabled={!hasRows} onClick={() => setOpen(isOpen ? null : g.name)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {hasRows && <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !isOpen && 'rotate-90')} />}
                    <span className="truncate">{g.name}</span>
                    {hasRows && <span className="text-xs text-muted-foreground">({g.rows!.length})</span>}
                    {g.note && <span className="text-xs text-muted-foreground">· {g.note}</span>}
                  </span>
                  <Money value={g.amount} />
                </button>
                {isOpen && hasRows && (
                  <table className="table mb-2 text-xs">
                    <tbody>
                      {g.rows!.map((r, i) => (
                        <tr key={r.id ?? i}>
                          <td className="whitespace-nowrap text-muted-foreground">{r.date ? day(r.date) : ''}</td>
                          <td>{r.description}{r.note && <span className="text-muted-foreground"> · {r.note}</span>}</td>
                          <td className="whitespace-nowrap text-muted-foreground">{r.account ?? ''}</td>
                          <td className="text-end"><Money value={r.amount} cents /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
      </>}
    </Modal>
  );
}
