import { useState } from 'react';
import { useParams } from 'react-router';
import { Send, HeartHandshake } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useCareRequest } from '@/lib/queries';
import { rpc } from '@/lib/db';
import { fmtDateTime, relative, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { EmptyState, FullPageLoader } from '@/components/ui/feedback';
import { useConfirm } from '@/components/ui/confirm';
import { CARE_STATUS, CARE_TYPE } from '@/lib/care';
import { MemberPage } from './ui';

export default function CareDetail() {
  const { id } = useParams();
  const { user, profile } = useAuth();
  const confirm = useConfirm();
  const { data: c, loading } = useCareRequest(id, true);
  const [msg, setMsg] = useState('');
  if (loading) return <FullPageLoader />;
  if (!c) return <EmptyState icon={<HeartHandshake />} title="Request not found" />;
  const mine = c.uid === user?.uid;
  const closed = c.status === 'closed' || c.status === 'completed';

  async function reply() {
    if (!msg.trim()) return;
    try {
      await rpc('add_care_response', { p_id: c!.id, p_text: msg.trim() }, ['care_requests']);
      setMsg('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function close() {
    if (!(await confirm({ title: 'Mark as resolved?', description: 'Let the pastors know this need has been met. Praise God!', confirmLabel: 'Mark resolved' }))) return;
    await rpc('add_care_response', { p_id: c!.id, p_text: 'Marked as resolved — thank you for praying with me.', p_close: true }, ['care_requests']);
    toast.success('Marked as resolved');
  }

  return (
    <MemberPage back={{ to: '/care', label: 'Care' }}>
      <div className="mx-auto max-w-2xl">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={CARE_TYPE[c.type]?.tone}>{CARE_TYPE[c.type]?.label}</Badge>
          <Badge tone={CARE_STATUS[c.status]?.tone}>{CARE_STATUS[c.status]?.label}</Badge>
          {c.visibility === 'public' && <Badge tone="info">On prayer wall · {c.prayedCount ?? 0} praying</Badge>}
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{c.subject || CARE_TYPE[c.type]?.label}</h1>
        <p className="mt-1 text-sm text-fg-3">Sent {fmtDateTime(c.createdAt)}{c.scheduledFor ? ` · Scheduled ${fmtDateTime(c.scheduledFor)}` : c.preferredDate ? ` · Preferred ${fmtDate(c.preferredDate)}` : ''}</p>
        <p className="mt-5 whitespace-pre-wrap rounded-2xl bg-surface-2 p-4 text-[15px] leading-relaxed">{c.details}</p>
        <h2 className="mb-3 mt-8 text-[15px] font-semibold">Conversation</h2>
        {(c.responses ?? []).length === 0 ? <p className="text-sm text-fg-3">No replies yet. You’ll get a notification when a pastor responds.</p> : (
          <ol className="space-y-2.5">
            {c.responses.map((r, i) => {
              const fromMe = r.uid ? r.uid === user?.uid : !r.staff && r.by === profile?.fullName;
              return (
                <li key={i} className={cn('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm', fromMe ? 'ml-auto rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md bg-surface-2')}>
                  <p className="whitespace-pre-wrap">{r.text}</p>
                  <p className={cn('mt-1 text-[11px]', fromMe ? 'text-white/70' : 'text-fg-3')}>{fromMe ? 'You' : r.by} · {relative(r.at)}</p>
                </li>
              );
            })}
          </ol>
        )}
        {mine && !closed && (
          <>
            <div className="mt-4 flex gap-2">
              <Textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Add an update…" className="min-h-0" />
              <Button onClick={reply} disabled={!msg.trim()} className="self-end" icon={<Send />} aria-label="Send" />
            </div>
            <Button variant="ghost" className="mt-4" onClick={close}>My need has been met</Button>
          </>
        )}
      </div>
    </MemberPage>
  );
}
