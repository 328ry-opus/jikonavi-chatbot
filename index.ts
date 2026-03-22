/**
 * Jikonavi Chat Edge Function
 * Proxies user messages to Gemini API with FAQ knowledge base.
 * Stores chat logs in Supabase.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── FAQ Knowledge (embedded at build time for simplicity) ──
const FAQ_KNOWLEDGE = `
Q: 交通事故に遭ったら最初に何をすべきですか？
A: まずは安全確保と警察・救急への連絡を行い、事故状況を記録しましょう。

Q: 事故の現場で警察を呼ばなくても大丈夫ですか？
A: 小さな事故でも必ず警察に連絡し、事故証明を取ることが重要です。

Q: 相手が逃げた場合はどうすればいいですか？
A: すぐに警察へ通報し、車両ナンバーや状況をできる限り記録しましょう。

Q: 自分が加害者になった場合の対応は？
A: 謝罪よりも先に安全確保と警察・保険会社への連絡を優先しましょう。

Q: 相手が無保険の場合、補償は受けられますか？
A: 自賠責保険や人身傷害保険で補償できるケースがあります。

Q: 物損事故を人身事故に変更できますか？
A: 症状が出た場合は、後から人身事故扱いに変更できます。

Q: 現場で示談しても問題ありませんか？
A: 現場示談はトラブルの元です。警察と保険会社に必ず報告しましょう。

Q: 事故直後にやってはいけないことはありますか？
A: 現場離脱・示談・SNS投稿は避け、冷静に事実を記録しましょう。

Q: 事故相手と連絡を取るべきですか？
A: 必要最小限の情報交換のみ行い、詳細なやり取りは避けましょう。

Q: 事故証明書はどこで取得できますか？
A: 警察署または交番で申請できます。郵送対応も可能です。

Q: むちうちはどのような症状ですか？
A: 首の痛みや頭痛、倦怠感、めまいなどが代表的な症状です。

Q: むちうちは事故直後に痛みが出ないことがありますか？
A: はい。数日後に症状が出ることが多く、早期受診が重要です。

Q: むちうちは自然に治りますか？
A: 放置すると悪化する可能性があり、治療が必要です。

Q: むちうちは整骨院で治療できますか？
A: はい。自賠責保険を使って整骨院で治療が可能です。

Q: むちうち治療に通う期間はどれくらいですか？
A: 平均で2〜3か月ほど通院するケースが多いです。

Q: むちうちが再発することはありますか？
A: あります。姿勢や筋肉の緊張が原因になる場合があります。

Q: むちうちで後遺症が残ることはありますか？
A: はい。適切な治療を怠ると慢性化することがあります。

Q: むちうちの治療にMRIは必要ですか？
A: 症状が強い場合や神経障害が疑われる際に有効です。

Q: むちうちで仕事を休む場合、補償はありますか？
A: 自賠責保険の休業損害として請求できます。

Q: むちうちは保険でカバーされますか？
A: はい。自賠責または任意保険で治療費が補償されます。

Q: 通院費は誰が支払いますか？
A: 自賠責保険が治療費を負担します。被害者の自己負担は原則ありません。

Q: 通院の交通費は補償されますか？
A: はい。公共交通機関やガソリン代も認められる場合があります。

Q: 保険会社が整骨院を指定してきました。従う必要はありますか？
A: ありません。通院先は自由に選べます。

Q: 自賠責保険の上限はありますか？
A: 120万円まで補償されます。超える場合は任意保険の対象です。

Q: 通院をやめると慰謝料に影響しますか？
A: します。早期に通院をやめると減額される可能性があります。

Q: 休業補償はどのように計算されますか？
A: 日額×休業日数で計算されます。証明書の提出が必要です。

Q: 診断書はどこで取得できますか？
A: 病院または整形外科で医師が発行します。

Q: 整骨院でも診断書は出せますか？
A: できません。医師の診断が必要です。

Q: 通院期間中に転院できますか？
A: はい。保険会社に連絡して手続きをすれば可能です。

Q: 自費で通院した場合、後で請求できますか？
A: 領収書があれば自賠責保険で精算できます。

Q: 示談はいつ行えばよいですか？
A: 治療が完了し、症状が安定してからが適切です。

Q: 示談金と慰謝料の違いは？
A: 示談金はすべての損害の合計、慰謝料は精神的損害への補償です。

Q: 弁護士費用特約とは何ですか？
A: 保険で弁護士費用をカバーできる補償制度です。

Q: 弁護士に依頼するメリットは？
A: 慰謝料増額や交渉の負担軽減が期待できます。

Q: 後遺障害等級はどうやって決まりますか？
A: 医師の診断書と症状固定後の審査で決まります。

Q: 示談書は自分で作成できますか？
A: 可能ですが、専門家に確認してもらうのが安全です。

Q: 示談後に再通院できますか？
A: 原則できません。再発時は別案件として対応します。

Q: 慰謝料はどのように計算されますか？
A: 通院日数と期間を基に自賠責基準で算出されます。

Q: 弁護士に依頼する費用はいくらですか？
A: 保険特約を使えば自己負担なしで依頼可能な場合もあります。

Q: 示談交渉がまとまらない場合はどうすれば？
A: 弁護士や交通事故紛争処理センターに相談しましょう。

Q: 整骨院と接骨院は違うのですか？
A: 名称が異なるだけで、業務内容はほぼ同じです。

Q: 事故後に体調が悪化するのはなぜ？
A: 精神的ストレスや自律神経の乱れが関係することがあります。

Q: 雨の日や気圧で痛みが出るのは後遺症？
A: むちうち後遺症の影響で天候に反応することがあります。

Q: 妊娠中でも交通事故治療を受けられますか？
A: 医師の許可があれば受けられます。電気治療は避けましょう。

Q: 子どもの交通事故治療は大人と違いますか？
A: 成長に合わせた治療が必要で、慎重なケアが求められます。

Q: 高齢者は回復に時間がかかりますか？
A: はい。筋肉や神経の回復が遅いため、長期化しやすいです。

Q: 自転車事故でも保険は使えますか？
A: 加害者がいれば自賠責・任意保険が適用されます。

Q: 交通事故による精神的な不安は相談できますか？
A: カウンセリングや心療内科での相談が有効です。

Q: 事故後に眠れないのは正常ですか？
A: 一時的なストレス反応であることが多いです。長引く場合は受診を。

Q: 交通事故治療でよくあるトラブルは？
A: 通院打ち切りや示談トラブルが多く、記録と報告が重要です。
`;

const SYSTEM_PROMPT = `あなたは「事故なび」のAIアシスタントです。交通事故に遭われた方のご相談に、丁寧にお答えします。

## 基本ルール
- 丁寧で安心感のある口調で回答してください
- 法的助言（「〜すべきです」「〜の義務があります」等の断定）は絶対に行わないでください。「〜の場合が多いです」「〜が一般的です」のように一般的な情報として伝えてください
- 具体的な慰謝料の金額を約束しないでください。目安としてのみ伝えてください
- 回答は200文字以内に収めてください。簡潔に要点をお伝えします
- 回答の最後に電話番号（0120-911-427）への誘導を1回だけ含めてください。本文中に既に電話番号が含まれている場合は、末尾の誘導は不要です
- 事故なびのサービス範囲外（交通事故と無関係）の質問には「申し訳ありませんが、交通事故に関するご相談のみ承っております」と回答してください
- 医療行為の具体的な指示はしないでください

## 事故なびについて
事故なびは、交通事故に遭われた方に最適な整骨院・接骨院を無料でご紹介するサービスです。
- 通院先の紹介は無料
- 自賠責保険適用で窓口負担0円
- 全国対応
- 電話相談: 0120-911-427（9:00〜21:00、年中無休）
- チャットやフォームでのお問い合わせには、通常3時間以内にスタッフからご連絡いたします
- お急ぎの場合はお電話（0120-911-427）が最も早くご対応できます

## FAQ（以下の情報をもとに回答してください）
${FAQ_KNOWLEDGE}
`;

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

// ── Rate limiting (simple in-memory) ──────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20; // messages per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(sessionId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(sessionId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Gemini API call ───────────────────────────────────────
async function callGemini(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
): Promise<ReadableStream> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Build Gemini conversation format
  const contents = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Add current message if not already in history
  if (!conversationHistory.length || conversationHistory[conversationHistory.length - 1].content !== userMessage) {
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }],
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 800,
          topP: 0.8,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        ],
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${err}`);
  }

  // Transform Gemini SSE stream to our simpler format
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`),
            );
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },
  });
}

// ── Log to DB ─────────────────────────────────────────────
async function logMessage(
  sessionId: string,
  userName: string,
  role: string,
  content: string,
  messageType: string,
) {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) return;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Upsert session
    await supabase.from('chat_sessions').upsert(
      {
        session_id: sessionId,
        user_name: userName,
        started_at: new Date().toISOString(),
        message_count: 1,
        used_ai: messageType === 'ai_response' || messageType === 'ai_question',
      },
      { onConflict: 'session_id', ignoreDuplicates: false },
    );

    // Increment message count
    await supabase.rpc('increment_chat_message_count', { p_session_id: sessionId });

    // Insert message
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      role,
      content,
      message_type: messageType,
    });
  } catch (err) {
    console.error('Log error:', err);
    // Don't fail the response if logging fails
  }
}

// ── Main handler ──────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  try {
    const body = await req.json();
    const { session_id, user_name, message, conversation_history } = body;

    if (!session_id || !message) {
      return new Response(
        JSON.stringify({ error: 'session_id and message are required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Enforce input length
    const sanitizedMessage = message.slice(0, 500);

    // Rate limit check
    if (!checkRateLimit(session_id)) {
      return new Response(
        JSON.stringify({ error: '質問の上限に達しました。しばらく時間をおいてからお試しください。' }),
        { status: 429, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    // Log user message (async, don't await)
    logMessage(session_id, user_name || '', 'user', sanitizedMessage, 'ai_question');

    // Call Gemini with streaming
    const stream = await callGemini(sanitizedMessage, conversation_history || []);

    return new Response(stream, {
      headers: {
        ...headers,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Chat function error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
