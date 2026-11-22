import http from "node:http";

const PORT = Number(process.env.PORT || 3001);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "idk037251@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "Alterhuman Lounge <onboarding@resend.dev>";

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept"
  });
  res.end(JSON.stringify(data));
}

async function sendViaResend({ category, replyEmail, title, content, senderInfo }) {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const textBody = [
    `[알터휴먼 라운지 비공개 문의/신고]`,
    `- 문의 유형: ${category || "일반 문의"}`,
    `- 보낸 사용자: ${senderInfo || "방문자"}`,
    `- 답변 이메일: ${replyEmail || "미입력"}`,
    `- 제목: ${title}`,
    ``,
    `[상세 내용]`,
    content
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [ADMIN_EMAIL],
      ...(replyEmail ? { reply_to: replyEmail } : {}),
      subject: `[알터휴먼 라운지 ${category || "문의"}] ${title}`,
      text: textBody
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Resend API 오류 (${res.status})`);
  }
  return data;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, adminEmail: ADMIN_EMAIL, resendConfigured: !!RESEND_API_KEY });
  }

  if (req.method === "POST" && req.url === "/api/support") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (!body.title || !body.content) {
          return sendJson(res, 400, { ok: false, error: "제목과 상세 내용을 입력해 주세요." });
        }
        const result = await sendViaResend(body);
        return sendJson(res, 200, { ok: true, id: result.id });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`Alterhuman Support Mail API running on port ${PORT} -> ${ADMIN_EMAIL}`);
});
