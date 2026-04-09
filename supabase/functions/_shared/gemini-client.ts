export type CallGeminiOptions = {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  thinkingBudget?: number;
  parseJson?: boolean;
};

export async function callGemini(
  apiKey: string,
  prompt: string,
  options: CallGeminiOptions = {},
): Promise<any> {
  const {
    model = "gemini-2.5-flash",
    temperature = 0,
    maxOutputTokens = 500,
    responseMimeType,
    thinkingBudget = 0,
    parseJson,
  } = options;

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget },
  };
  if (responseMimeType) {
    generationConfig.responseMimeType = responseMimeType;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Gemini API error: ${response.status}${
        errText ? ` ${errText.slice(0, 500)}` : ""
      }`,
    );
  }

  const geminiJson = await response.json();
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text
    ?.trim();

  const shouldParseJson = typeof parseJson === "boolean"
    ? parseJson
    : responseMimeType === "application/json";
  if (!shouldParseJson) {
    return rawText || "";
  }

  try {
    return JSON.parse(rawText || "{}");
  } catch {
    throw new Error(`Invalid JSON: ${rawText?.slice(0, 200)}`);
  }
}
