// ============================================================================
// geo-audit-pipeline / scripts/collect.mjs
//
// 매일 아침 GitHub Actions가 이 스크립트를 실행합니다.
// 1) 10개 질문을 ChatGPT / Gemini API에 "웹검색 켠 상태"로 각각 전송
// 2) 두 답변을 Gemini API에 다시 보내 "실제로 어떤 병원들을 추천/언급했는지"를
//    엄격한 규칙으로 판정 (우리 병원 노출 여부 + 함께 언급된 전체 브랜드 순서)
// 3) 결과를 docs/data/results.json 에 저장 (대시보드가 이 파일을 읽습니다)
//
// 실행: node scripts/collect.mjs
// 필요한 환경변수: OPENAI_API_KEY, GEMINI_API_KEY
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 설정 — 모델명은 각 회사가 주기적으로 바꿉니다. 호출이 실패하기 시작하면
// 이 상수들을 해당 회사 문서의 최신 모델명으로 교체하세요.
// ---------------------------------------------------------------------------
const OPENAI_MODEL = "gpt-5.6";
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_JUDGE_MODEL = "gemini-3.7-flash"; // 판정에 쓰는 모델 (검색 없이 텍스트만 판단)

const RESULTS_PATH = path.join(process.cwd(), "docs", "data", "results.json");
const MAX_HISTORY = 120; // 최근 120일치만 보관

// ---------------------------------------------------------------------------
// 측정 대상 & 질문 (원장님이 지정한 10개 질문, 그대로 유지)
// 질문을 바꾸려면 아래 배열과, 필요하면 QUESTION_GROUPS도 함께 수정하세요.
// ---------------------------------------------------------------------------
const CLINIC_NAME = "브이앤엠제이피부과 (V&MJ Dermatology / mjskinclinic.com)";

const QUESTIONS = [
  "강남 울쎄라 잘하는 병원 추천해줘",
  "압구정 울쎄라 잘하는 병원 추천해줘",
  "강남 써마지 잘하는 병원 추천해줘",
  "압구정 써마지 잘하는 병원 추천해줘",
  "한국에서 울쎄라 잘하는 피부과 추천해줘",
  "서울에서 울쎄라 잘하는 피부과 추천해줘",
  "한국에서 써마지 잘하는 피부과 추천해줘",
  "서울에서 써마지 잘하는 피부과 추천해줘",
  "울쎄라 잘하는 원장 추천해줘",
  "써마지 잘하는 원장 추천해줘",
];

// 대시보드의 "시술별 순위" 표에 쓰이는 질문 그룹 (0-based 인덱스)
const QUESTION_GROUPS = {
  "울쎄라": [0, 1, 4, 5, 8],
  "써마지": [2, 3, 6, 7, 9],
};

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1) 두 플랫폼에 실제 질문 보내기 (웹검색 도구 켠 상태)
//    각각 { text, citations: [{domain, url}] } 를 반환
// ---------------------------------------------------------------------------

async function askOpenAI(question) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      tools: [{ type: "web_search" }],
      input: question,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = (data.output || []).find((o) => o.type === "message");
  const textBlock = msg?.content?.find((c) => c.type === "output_text");
  if (!textBlock) throw new Error("OpenAI: 응답에서 본문 텍스트를 찾지 못함");
  const citations = (textBlock.annotations || [])
    .filter((a) => a.type === "url_citation" && a.url)
    .map((a) => ({ url: a.url, domain: domainOf(a.url) }))
    .filter((c) => c.domain);
  return { text: textBlock.text, citations };
}

async function askGemini(question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini: 응답에서 본문 텍스트를 찾지 못함");
  const citations = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => ({ url: c.web?.uri, domain: c.web?.uri ? domainOf(c.web.uri) : null }))
    .filter((c) => c.domain);
  return { text, citations };
}

// ---------------------------------------------------------------------------
// 2) 판정(judge) — 제미나이 API를 심판으로 사용해 "실제 노출"만 엄격하게 채점
//    (병원의 원래 측정 규칙을 그대로 프롬프트에 반영)
//    ※ 심판을 측정 대상 엔진 중 하나(Gemini)가 겸하는 구조입니다. ChatGPT 답변을
//      채점할 때는 독립적인 제3자 채점이지만, Gemini 자신의 답변을 채점할 때는
//      "자기 답을 자기가 채점"하는 셈이라 그 부분만큼은 완전히 중립적이지 않을 수
//      있습니다 (이전에 Claude가 심판+측정 대상을 겸했을 때와 동일한 구조입니다).
// ---------------------------------------------------------------------------

const JUDGE_RULE = `
당신은 병원 GEO(생성형 AI 노출) 측정 심판입니다. 아래 규칙을 엄격히 지켜 판정하세요.

[판정 대상 병원] ${CLINIC_NAME} (다른 이름으로 등장할 수 있음: V&MJ, 브이앤엠제이, mjskinclinic)

[절대 규칙]
- 검색 결과나 출처 각주에 병원명이 등장한 것만으로는 노출로 인정하지 않는다.
- AI의 최종 답변 "본문"에서 실제로 병원을 추천하거나 언급한 경우에만 노출/등장으로 인정한다.
- 추천 순위가 명확한 번호/서열로 제시되지 않으면 rank는 null로 하고 "순위 확인 불가"로 처리한다.
- 확인되지 않은 내용을 추측하지 않는다.

각 답변마다 다음을 판정하세요:
1. exposed: 우리 병원이 본문에서 실제로 추천/언급되었는가 (true/false)
2. rank: 명확한 순번이 있다면 그 숫자, 없으면 null
3. brands: 답변 본문에 실제로 등장한 모든 병원/클리닉을 "제시된 순서 그대로" 나열 (우리 병원 포함, 최대 8개). 순서 정보가 없는 나열형 답변이면 언급된 순서대로 적으면 됩니다. 병원이 하나도 언급되지 않았다면 빈 배열.
4. reasoning: 판정 근거 한 문장 (한국어)

아래 JSON 형식으로만 응답하세요 (설명 문장, 마크다운 코드펜스 없이 순수 JSON만):
{
  "gpt":    { "exposed": true|false, "rank": number|null, "reasoning": "...", "brands": [{"name":"...","isUs":true|false}, ...] },
  "gemini": { "exposed": true|false, "rank": number|null, "reasoning": "...", "brands": [...] }
}
`.trim();

async function judgeAnswers(question, answers) {
  const prompt = `${JUDGE_RULE}

[질문] ${question}

[ChatGPT 답변]
${answers.gpt ?? "(호출 실패 — 판정 불가로 처리)"}

[Gemini 답변]
${answers.gemini ?? "(호출 실패 — 판정 불가로 처리)"}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_JUDGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1536 },
    }),
  });
  if (!res.ok) throw new Error(`Judge(Gemini) ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Judge: 응답에서 텍스트를 찾지 못함");

  // 코드펜스가 섞여 와도 안전하게 JSON만 추출
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge: JSON을 찾지 못함 — 원문: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// 3) 메인 파이프라인
// ---------------------------------------------------------------------------

function emptyVerdict(note) {
  return { exposed: null, rank: null, reasoning: note, brands: [], citations: [], error: true };
}

async function collectQuestion(question) {
  const answers = {};
  const citationsByPlatform = {};
  const errors = {};

  await Promise.all(
    [
      ["gpt", askOpenAI],
      ["gemini", askGemini],
    ].map(async ([key, fn]) => {
      try {
        const { text, citations } = await fn(question);
        answers[key] = text;
        citationsByPlatform[key] = citations;
      } catch (err) {
        errors[key] = String(err.message || err);
        console.error(`[${question}] ${key} 호출 실패:`, errors[key]);
      }
    })
  );

  let verdicts;
  try {
    verdicts = await judgeAnswers(question, answers);
  } catch (err) {
    console.error(`[${question}] 판정 실패:`, err.message || err);
    verdicts = { gpt: emptyVerdict("판정 실패"), gemini: emptyVerdict("판정 실패") };
  }

  for (const key of ["gpt", "gemini"]) {
    if (errors[key]) {
      verdicts[key] = emptyVerdict(`API 호출 실패: ${errors[key]}`);
    } else {
      verdicts[key] = { ...verdicts[key], citations: citationsByPlatform[key] || [], error: false };
    }
  }

  return verdicts;
}

function summarize(rows) {
  const total = rows.length;
  const valid = rows.filter((r) => !r.error);
  const exposed = valid.filter((r) => r.exposed).length;
  const top3 = valid.filter((r) => r.exposed && r.rank && r.rank <= 3).length;
  const top1 = valid.filter((r) => r.exposed && r.rank === 1).length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { total, exposed, top3, top1, expPct: pct(exposed), top3Pct: pct(top3), top1Pct: pct(top1) };
}

async function loadExisting() {
  try {
    const raw = await readFile(RESULTS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { history: [] };
  }
}

async function main() {
  console.log(`GEO 측정 시작 — ${new Date().toISOString()}`);

  const perQuestion = { gpt: [], gemini: [] };

  for (const question of QUESTIONS) {
    console.log(`질문 진행 중: ${question}`);
    const verdicts = await collectQuestion(question);
    for (const key of ["gpt", "gemini"]) {
      perQuestion[key].push(verdicts[key]);
    }
  }

  const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    questions: QUESTIONS,
    questionGroups: QUESTION_GROUPS,
    platforms: {
      gpt: { rows: perQuestion.gpt, stats: summarize(perQuestion.gpt) },
      gemini: { rows: perQuestion.gemini, stats: summarize(perQuestion.gemini) },
    },
  };

  const existing = await loadExisting();
  const history = Array.isArray(existing.history) ? existing.history : [];
  // 같은 날짜에 재실행된 경우 기존 항목을 교체
  const filtered = history.filter((h) => h.date !== snapshot.date);
  filtered.push(snapshot);
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = filtered.slice(-MAX_HISTORY);

  const output = { latest: snapshot, history: trimmed };

  await mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`저장 완료: ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("파이프라인 실패:", err);
  process.exit(1);
});
