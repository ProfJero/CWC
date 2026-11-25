import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BadgeCheck, GitMerge, UserRoundPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useMembers, useUnverifiedMembers } from '@/lib/queries';
import { patchDoc, rpc } from '@/lib/db';
import { formatPhone } from '@/lib/phone';
import { relative } from '@/lib/format';
import { STATUS_META } from '@/lib/members';
import type { Member } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm';

/**
 * People who introduced themselves in the app. Staff confirm them — or merge them into an
 * existing record when we already know them (matched by phone or name).
 */
export function NewRegistrations({ compact }: { compact?: boolean }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { data: pending } = useUnverifiedMembers(can('people.view'));
  const { data: all } = useMembers(can('people.view'));
  const [mergeFor, setMergeFor] = useState<{ m: Member; candidates: Member[] } | null>(null);

  const matches = useMemo(() => {
    const map = new Map<string, Member[]>();
    for (const p of pending) {
      const last = p.lastName.toLowerCase();
      map.set(
        p.id,
        all.filter((o) => o.id !== p.id && o.verified !== false && ((p.phone && (o.phone === p.phone || o.altPhone === p.phone)) || (last && o.lastName.toLowerCase() === last && o.firstName.toLowerCase().slice(0, 3) === p.firstName.toLowerCase().slice(0, 3)))),
      );
    }
    return map;
  }, [pending, all]);

  if (!pending.length) return null;

  async function verify(m: Member) {
    try {
      await patchDoc('members', m.id, { verified: true }, { audit: `Confirmed self-registered ${m.fullName}` });
      toast.success(`${m.firstName} confirmed`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function merge(keep: Member, remove: Member) {
    if (!(await confirm({ title: `Merge into ${keep.fullName}?`, description: `${remove.fullName}’s app account, check-ins and requests move to the existing record, and the duplicate is removed.`, confirmLabel: 'Merge' }))) return;
    try {
      await rpc('merge_members', { p_keep: keep.id, p_remove: remove.id }, ['members', 'users', 'attendance', 'gifts', 'followups']);
      toast.success('Records merged');
      setMergeFor(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const list = compact ? pending.slice(0, 5) : pending;
  return (
    <Card className="mb-4 border-gold-200/80 dark:border-gold-500/25">
      <CardHeader title="New in the app" description="People who introduced themselves — welcome them and confirm their details." icon={<UserRoundPlus />} action={<Badge tone="gold">{pending.length} to review</Badge>} />
      <ul className="divide-y divide-line border-t border-line">
        {list.map((m) => {
          const cands = matches.get(m.id) ?? [];
          return (
            <li key={m.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
              <Link to={`/admin/people/${m.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={m.fullName} src={m.photoUrl} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{m.fullName}</span>
                  <span className="block truncate text-xs text-fg-3">{formatPhone(m.phone)} · {relative(m.createdAt)}</span>
                </span>
                <Badge tone={STATUS_META[m.membershipStatus]?.tone}>{STATUS_META[m.membershipStatus]?.label}</Badge>
              </Link>
              <div className="flex gap-2">
                {cands.length > 0 && can('people.delete') && (
                  <Button size="xs" variant="outline" icon={<GitMerge />} onClick={() => setMergeFor({ m, candidates: cands })}>
                    {cands.length === 1 ? 'Possible match' : `${cands.length} matches`}
                  </Button>
                )}
                {can('people.manage') && <Button size="xs" icon={<BadgeCheck />} onClick={() => verify(m)}>Confirm</Button>}
              </div>
            </li>
          );
        })}
      </ul>
      {compact && pending.length > list.length && <div className="border-t border-line px-5 py-2.5 text-right"><Link to="/admin/people" className="text-[13px] font-medium text-accent dark:text-brand-300">Review all {pending.length}</Link></div>}
      <Modal open={!!mergeFor} onOpenChange={(o) => !o && setMergeFor(null)} title="Is this someone we know?" description={mergeFor ? `${mergeFor.m.fullName} · ${formatPhone(mergeFor.m.phone)}` : ''} size="sm" footer={<Button variant="outline" onClick={() => setMergeFor(null)}>Not a match</Button>}>
        <ul className="space-y-2">
          {mergeFor?.candidates.map((c) => (
            <li key={c.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
              <Avatar name={c.fullName} src={c.photoUrl} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{c.fullName}</span><span className="block text-xs text-fg-3">{formatPhone(c.phone)} · {STATUS_META[c.membershipStatus]?.label}</span></span>
              <Button size="xs" onClick={() => merge(c, mergeFor.m)}>Merge</Button>
            </li>
          ))}
        </ul>
      </Modal>
    </Card>
  );
}
