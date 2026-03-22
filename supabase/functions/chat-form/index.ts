/**
 * Jikonavi Chat Form Edge Function
 * Receives form submissions from the chat widget and stores them in Supabase.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://jiko-navi.jp',
  'https://www.jiko-navi.jp',
  'http://jiko-navi.sakura.ne.jp',
  'https://328ry-opus.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin: string) {
  const allowed = ALLOWED_ORIGINS.some((o) => origin?.startsWith(o)) || origin?.includes('localhost') || origin?.includes('127.0.0.1');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ── Main handler ──────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  try {
    const body = await req.json();
    const { session_id, form_data, page_url } = body;

    if (!session_id || !form_data) {
      return new Response(
        JSON.stringify({ error: 'session_id and form_data are required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not set');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Update session with form data
    const { error: sessionError } = await supabase.from('chat_sessions').upsert(
      {
        session_id,
        user_name: form_data.name || '',
        started_at: new Date().toISOString(),
        message_count: 0,
        used_ai: false,
      },
      { onConflict: 'session_id', ignoreDuplicates: false },
    );
    if (sessionError) console.error('Session upsert error:', sessionError.message);

    // Store form submission as a message
    const { error: msgError } = await supabase.from('chat_messages').insert({
      session_id,
      role: 'system',
      content: JSON.stringify({
        type: 'form_submission',
        inquiry_type: form_data.inquiry_type || '',
        accident_type: form_data.accident_type || '',
        name: form_data.name || '',
        phone: form_data.phone || '',
        area: form_data.area || '',
        contact_time: form_data.contact_time || '',
        page_url: page_url || '',
        submitted_at: new Date().toISOString(),
      }),
      message_type: 'form_submission',
    });
    if (msgError) console.error('Message insert error:', msgError.message);

    // ── Normalize area input ─────────────────────────────
    let area = (form_data.area || '').trim();
    // Add "駅" suffix if it looks like a station name without it
    if (area && !area.endsWith('駅') && !area.endsWith('市') && !area.endsWith('区') && !area.endsWith('町') && !area.endsWith('村') && !area.endsWith('県') && !area.endsWith('府') && !area.endsWith('都') && !area.endsWith('道') && area.length <= 15) {
      // Check if it's likely a station name (short text without address-like suffixes)
      if (!/[0-9０-９丁目番地号]/.test(area)) {
        area = area + '駅';
      }
    }

    // ── Normalize phone number ──────────────────────────
    let phone = (form_data.phone || '').replace(/[\s\-\u2010-\u2015\u2212\uFF0D]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (/^0[789]0\d{8}$/.test(phone)) {
      // Mobile: 090-1234-5678
      phone = phone.slice(0, 3) + '-' + phone.slice(3, 7) + '-' + phone.slice(7);
    } else if (/^0120\d{6}$/.test(phone)) {
      // Toll-free: 0120-123-456
      phone = phone.slice(0, 4) + '-' + phone.slice(4, 7) + '-' + phone.slice(7);
    } else if (/^0\d{9}$/.test(phone)) {
      // Landline: detect area code length by prefix
      // 2-digit area: 03, 06
      // 3-digit area: 011, 022, 025, 027, 028, 029, 042, 043, 044, 045, 046, 047, 048, 052, 053, 054, 055, 058, 072, 073, 075, 076, 077, 078, 079, 082, 083, 084, 086, 087, 088, 089, 092, 093, 095, 096, 097, 098, 099
      const prefix2 = phone.slice(0, 2);
      if (prefix2 === '03' || prefix2 === '06') {
        phone = phone.slice(0, 2) + '-' + phone.slice(2, 6) + '-' + phone.slice(6);
      } else {
        // 3-digit area code (most common for landlines)
        phone = phone.slice(0, 3) + '-' + phone.slice(3, 6) + '-' + phone.slice(6);
      }
    }

    // ── Resolve furigana (name_kana) ───────────────────────
    let nameKana = form_data.name_kana || '';
    let kanaPredicted = false;
    const kanaRegex = /^[\u3040-\u309F\u30A0-\u30FF\u30FC\s\u3000]+$/;

    if (!nameKana && form_data.name) {
      const name = form_data.name.trim();

      // If name is already all kana, use it directly
      if (kanaRegex.test(name)) {
        nameKana = name;
      } else {
        // Name contains kanji — predict furigana via Gemini
        try {
          const apiKey = Deno.env.get('GEMINI_API_KEY');
          if (apiKey) {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: `この人名のふりがなをひらがなのみで答えてください。余計な説明は不要です。\n${name}` }] }],
                  generationConfig: { temperature: 0, maxOutputTokens: 50 },
                }),
              },
            );
            if (res.ok) {
              const json = await res.json();
              const predicted = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (predicted && kanaRegex.test(predicted)) {
                nameKana = predicted;
                kanaPredicted = true;
              }
            } else {
              console.error('Gemini API error:', res.status, await res.text());
            }
          } else {
            console.error('GEMINI_API_KEY not set for chat-form');
          }
        } catch (e) {
          console.error('Furigana prediction failed:', e);
        }
      }
    }

    // ── Check for duplicate patients ────────────────────
    let dupNote = '';
    try {
      const { data: dups } = await supabase.rpc('find_duplicate_patients', {
        p_phone: phone || null,
        p_name_kana: null,
        p_exclude_id: null,
      });
      if (dups && dups.length > 0) {
        dupNote = `\n【重複の可能性】既存患者: ${dups.map((d: any) => `${d.name_kanji || d.id}(${d.status})`).join(', ')}`;
      }
    } catch (e) {
      console.error('Duplicate check failed:', e);
    }

    // ── Create patient record in CRM ──────────────────────
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);
    const patientId = 'p' + Date.now();

    const notes = [
      '【チャットbot経由】',
      form_data.inquiry_type ? `相談内容: ${form_data.inquiry_type}` : '',
      form_data.accident_type ? `事故状況: ${form_data.accident_type}` : '',
      area ? `希望エリア: ${area}` : '',
      form_data.contact_time ? `連絡希望: ${form_data.contact_time}` : '',
      kanaPredicted ? `ふりがな「${nameKana}」はAI予測です（要確認）` : '',
      page_url ? `送信元: ${page_url}` : '',
    ].filter(Boolean).join('\n') + dupNote;

    const { error: patientError } = await supabase.from('patients').insert({
      id: patientId,
      name_kanji: form_data.name || '',
      name_kana: nameKana,
      phone,
      address: area,
      channel: 'chat',
      status: '問合せ受付',
      staff: 'ボット',
      inquiry_date: todayStr,
      inquiry_time: timeStr,
      next_date: todayStr,
      notes,
      check_permission: false,
      check_clinic: false,
      check_contacted: false,
      check_sent: false,
    });

    if (patientError) {
      console.error('Patient insert error:', patientError.message);
      return new Response(
        JSON.stringify({ success: false, error: 'Patient registration failed' }),
        { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Link patient to chat session
    const { error: linkError } = await supabase.from('chat_sessions').update({
      patient_id: patientId,
      converted: true,
    }).eq('session_id', session_id);
    if (linkError) console.error('Session link error:', linkError.message);

    // ── Send email notification via GAS webhook ─────────
    const GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyRw5LahkEShM7VVEmCLQtduVNKTuBn-KiurNQSQUkgPV-ueUtNCk2_b4wgvuqgB2s9/exec';
    try {
      await fetch(GAS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
        redirect: 'follow',
        body: JSON.stringify({
          name: form_data.name || '',
          phone,
          area,
          inquiry_type: form_data.inquiry_type || '',
          accident_type: form_data.accident_type || '',
          contact_time: form_data.contact_time || '',
          page_url: page_url || '',
        }),
      });
    } catch (e) {
      console.error('GAS notification failed:', e);
      // Non-critical: don't fail the form submission if email fails
    }

    return new Response(
      JSON.stringify({ success: true, patient_id: patientId }),
      { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Chat form error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
