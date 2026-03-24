/**
 * Notify Overdue — Supabase Edge Function
 * Runs daily at 8:00 JST (23:00 UTC) via Supabase Cron.
 * Checks for patients with overdue NEXT dates and sends notifications.
 *
 * Rules:
 * - 1 day overdue → notify assigned staff
 * - 2+ days overdue → escalate to manager (松本社長)
 *
 * Notification channels: GAS Webhook (email) for now.
 * LINE/Chatwork can be added later.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Allow manual trigger via POST or Cron trigger
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not set');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get today's date in JST
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    const todayStr = jstNow.toISOString().slice(0, 10);

    // Find overdue patients (next_date < today, active statuses)
    const activeStatuses = ['問合せ受付', 'ヒアリング済', '送客調整中', '通院確認待ち', '送客済', '通院中'];
    const { data: overduePatients, error: pErr } = await supabase
      .from('patients')
      .select('id, name_kanji, name_kana, phone, status, staff, next_date, clinic_id')
      .lt('next_date', todayStr)
      .not('next_date', 'is', null)
      .in('status', activeStatuses)
      .order('next_date', { ascending: true });

    if (pErr) throw pErr;
    if (!overduePatients || overduePatients.length === 0) {
      return new Response(JSON.stringify({ message: 'No overdue patients', count: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Calculate overdue days for each patient
    const results = { notified: 0, escalated: 0, skipped: 0 };

    for (const patient of overduePatients) {
      const nextDate = new Date(patient.next_date + 'T00:00:00+09:00');
      const diffMs = jstNow.getTime() - nextDate.getTime();
      const overdueDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (overdueDays < 1) continue;

      const notificationType = overdueDays >= 2 ? 'escalation' : 'overdue_reminder';

      // Check idempotency: skip if already notified today for same type
      const { data: existing } = await supabase
        .from('notification_log')
        .select('id')
        .eq('patient_id', patient.id)
        .eq('notification_type', notificationType)
        .eq('notified_date', todayStr)
        .maybeSingle();

      if (existing) {
        results.skipped++;
        continue;
      }

      // Build notification content
      const patientName = patient.name_kanji || patient.name_kana || patient.id;
      const staffName = patient.staff || '未担当';
      const content = overdueDays >= 2
        ? `【エスカレーション】${patientName}（${patient.status}）が${overdueDays}日超過しています。担当: ${staffName}`
        : `【フォロー超過】${patientName}（${patient.status}）が${overdueDays}日超過しています。担当: ${staffName}`;

      // Send notification via GAS webhook (email)
      const GAS_WEBHOOK_URL = Deno.env.get('NOTIFY_GAS_WEBHOOK_URL');
      let success = true;
      if (GAS_WEBHOOK_URL) {
        try {
          const resp = await fetch(GAS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            redirect: 'follow',
            body: JSON.stringify({
              type: notificationType,
              patient_name: patientName,
              patient_id: patient.id,
              status: patient.status,
              staff: staffName,
              overdue_days: overdueDays,
              next_date: patient.next_date,
              message: content,
            }),
          });
          success = resp.ok;
        } catch (e) {
          console.error('Notification send failed:', e);
          success = false;
        }
      }

      // Log notification
      await supabase.from('notification_log').insert({
        patient_id: patient.id,
        notification_type: notificationType,
        channel: 'email',
        content,
        success,
        notified_date: todayStr,
      });

      if (overdueDays >= 2) {
        results.escalated++;
      } else {
        results.notified++;
      }
    }

    return new Response(
      JSON.stringify({
        message: 'Notification check completed',
        total_overdue: overduePatients.length,
        ...results,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Notify overdue error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
