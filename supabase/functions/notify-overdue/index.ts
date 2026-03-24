/**
 * Notify Overdue — Supabase Edge Function
 * Runs daily at 8:00 JST (23:00 UTC) via Supabase Cron.
 * Checks for patients with overdue NEXT dates and sends a single batch email.
 *
 * Rules:
 * - 1 day overdue → overdue_reminder
 * - 2+ days overdue → escalation
 * - All patients sent in ONE GAS webhook call to avoid timeout
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
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

    // Batch idempotency check: get all already-notified patient_ids for today
    const { data: alreadyNotified } = await supabase
      .from('notification_log')
      .select('patient_id, notification_type')
      .eq('notified_date', todayStr);
    const notifiedSet = new Set((alreadyNotified || []).map(n => `${n.patient_id}:${n.notification_type}`));

    // Build lists of patients to notify
    const reminders: any[] = [];
    const escalations: any[] = [];
    const logEntries: any[] = [];
    const results = { notified: 0, escalated: 0, skipped: 0 };

    for (const patient of overduePatients) {
      const nextDate = new Date(patient.next_date + 'T00:00:00+09:00');
      const diffMs = jstNow.getTime() - nextDate.getTime();
      const overdueDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (overdueDays < 1) continue;

      const notificationType = overdueDays >= 2 ? 'escalation' : 'overdue_reminder';
      const key = `${patient.id}:${notificationType}`;
      if (notifiedSet.has(key)) {
        results.skipped++;
        continue;
      }

      const patientName = patient.name_kanji || patient.name_kana || patient.id;
      const staffName = patient.staff || '未担当';
      const entry = { patient_name: patientName, patient_id: patient.id, status: patient.status, staff: staffName, overdue_days: overdueDays, next_date: patient.next_date };

      if (notificationType === 'escalation') {
        escalations.push(entry);
        results.escalated++;
      } else {
        reminders.push(entry);
        results.notified++;
      }

      logEntries.push({
        patient_id: patient.id,
        notification_type: notificationType,
        channel: 'email',
        content: `${notificationType === 'escalation' ? '【エスカレーション】' : '【フォロー超過】'}${patientName}（${patient.status}）${overdueDays}日超過 担当:${staffName}`,
        success: true,
        notified_date: todayStr,
      });
    }

    // Nothing new to notify
    if (reminders.length === 0 && escalations.length === 0) {
      return new Response(JSON.stringify({ message: 'All already notified today', ...results }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Send ONE batch webhook to GAS
    const GAS_WEBHOOK_URL = Deno.env.get('NOTIFY_GAS_WEBHOOK_URL');
    let success = true;
    if (GAS_WEBHOOK_URL) {
      try {
        const resp = await fetch(GAS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          redirect: 'follow',
          body: JSON.stringify({
            type: 'batch_overdue',
            date: todayStr,
            reminders,
            escalations,
            total: reminders.length + escalations.length,
          }),
        });
        success = resp.ok;
      } catch (e) {
        console.error('Notification send failed:', e);
        success = false;
      }
    }

    // Batch insert logs
    if (logEntries.length > 0) {
      if (!success) logEntries.forEach(e => e.success = false);
      await supabase.from('notification_log').insert(logEntries);
    }

    return new Response(
      JSON.stringify({
        message: 'Notification check completed',
        total_overdue: overduePatients.length,
        ...results,
        email_sent: success,
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
