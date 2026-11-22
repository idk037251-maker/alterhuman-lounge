import http from "node:http";
import { Resend } from "resend";

const PORT = Number(process.env.PORT || 3001);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "idk037251@gmail.com").trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
// Resend 무료 플랜 테스트 시 반드시 허용된 발신자 주소(onboarding@resend.dev) 사용
const FROM_EMAIL = (process.env.FROM_EMAIL || "숲톡 <onboarding@resend.dev>").trim();
const CLOUD_DB_URL = "https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/alterhuman_cloud_inquiries_v1";
const ROOM_MEMBERS_DB_URL = "https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/alterhuman_cloud_room_members_v1";
const ROOM_MSG_DB_PREFIX = "https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/alterhuman_room_msgs_";
const COMMUNITIES_DB_URL = "https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/alterhuman_cloud_communities_v1";
const DELETED_COMMS_DB_URL = "https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/alterhuman_cloud_deleted_comms_v1";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept"
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function parseMessageTimestampMs(m) {
  if (!m) return 0;
  if (m.createdAt) {
    const t = Date.parse(m.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof m.id === "string") {
    const match = m.id.match(/^msg-(\d+)-/);
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

async function getRoomMembersMap() {
  try {
    const res = await fetch(`${ROOM_MEMBERS_DB_URL}?_t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return {};
    const parsed = await res.json().catch(() => ({}));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveRoomMembersMap(map) {
  const res = await fetch(ROOM_MEMBERS_DB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(map)
  });
  return res.ok;
}

async function backupInquiryToDb(inquiry) {
  try {
    let existing = [];
    const getRes = await fetch(`${CLOUD_DB_URL}?_t=${Date.now()}`, { cache: "no-store" });
    if (getRes.ok) {
      const parsed = await getRes.json().catch(() => []);
      if (Array.isArray(parsed)) existing = parsed;
    }
    const updated = [inquiry, ...existing.filter((item) => item && item.id !== inquiry.id)].slice(0, 200);
    const putRes = await fetch(CLOUD_DB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated)
    });
    if (!putRes.ok) {
      console.error("[Support DB Backup Error] KVDB POST failed:", putRes.status, await putRes.text().catch(() => ""));
      return false;
    }
    console.log(`[Support DB Backup] Saved inquiry ${inquiry.id} to cloud DB.`);
    return true;
  } catch (err) {
    console.error("[Support DB Backup Exception]", err);
    return false;
  }
}

async function sendViaResendSdk(inquiry) {
  if (!RESEND_API_KEY || !resend) {
    const err = new Error("RESEND_API_KEY 환경변수가 설정되지 않았습니다.");
    err.code = "MISSING_ENV_RESEND_API_KEY";
    throw err;
  }

  const textBody = [
    `[숲톡 비공개 문의/신고]`,
    `- 접수 번호: ${inquiry.id}`,
    `- 접수 시각: ${inquiry.createdAt}`,
    `- 문의 유형: ${inquiry.category}`,
    `- 보낸 사용자: ${inquiry.senderInfo}`,
    `- 답변 이메일: ${inquiry.replyEmail || "미입력"}`,
    `- 제목: ${inquiry.title}`,
    ``,
    `[상세 내용]`,
    inquiry.content
  ].join("\n");

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [ADMIN_EMAIL],
    ...(inquiry.replyEmail ? { replyTo: inquiry.replyEmail } : {}),
    subject: `[숲톡 ${inquiry.category}] ${inquiry.title}`,
    text: textBody
  });

  if (error) {
    const sdkErr = new Error(error.message || "Resend SDK 발송 실패");
    sdkErr.name = error.name || "ResendError";
    sdkErr.statusCode = error.statusCode;
    throw sdkErr;
  }

  return data;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      adminEmail: ADMIN_EMAIL,
      fromEmail: FROM_EMAIL,
      resendConfigured: !!RESEND_API_KEY,
      serverTimeMs: Date.now(),
      serverUtc: new Date().toISOString()
    });
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // 공용 커뮤니티 목록 조회 (모든 계정에 동일한 전체 공개 커뮤니티 반환)
  if (req.method === "GET" && parsedUrl.pathname === "/api/communities") {
    (async () => {
      try {
        const [commsRes, delRes] = await Promise.all([
          fetch(`${COMMUNITIES_DB_URL}?_t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${DELETED_COMMS_DB_URL}?_t=${Date.now()}`, { cache: "no-store" })
        ]);
        const rawComms = commsRes.ok ? await commsRes.json().catch(() => []) : [];
        const rawDeleted = delRes.ok ? await delRes.json().catch(() => []) : [];
        const deletedSet = new Set((Array.isArray(rawDeleted) ? rawDeleted : []).map(String));
        const communities = (Array.isArray(rawComms) ? rawComms : []).filter(
          (c) => c && c.id && !deletedSet.has(String(c.id))
        );
        return sendJson(res, 200, { ok: true, communities });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    })();
    return;
  }

  // 새 커뮤니티 생성 및 중앙 DB 영구 저장
  if (req.method === "POST" && parsedUrl.pathname === "/api/communities") {
    readJsonBody(req)
      .then(async (body) => {
        const comm = body && body.community ? body.community : body;
        if (!comm || !comm.id || !comm.name) {
          return sendJson(res, 400, { ok: false, error: "커뮤니티 ID와 이름이 필요합니다." });
        }
        const commId = String(comm.id);
        const normalizedComm = { ...comm, id: commId };

        const [commsRes, delRes] = await Promise.all([
          fetch(`${COMMUNITIES_DB_URL}?_t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${DELETED_COMMS_DB_URL}?_t=${Date.now()}`, { cache: "no-store" })
        ]);
        const existing = commsRes.ok ? await commsRes.json().catch(() => []) : [];
        const deleted = delRes.ok ? await delRes.json().catch(() => []) : [];
        const deletedSet = new Set((Array.isArray(deleted) ? deleted : []).map(String));

        const commMap = new Map();
        commMap.set(commId, normalizedComm);
        for (const c of (Array.isArray(existing) ? existing : [])) {
          if (c && c.id && !deletedSet.has(String(c.id)) && !commMap.has(String(c.id))) {
            commMap.set(String(c.id), { ...c, id: String(c.id) });
          }
        }
        const merged = Array.from(commMap.values());
        await fetch(COMMUNITIES_DB_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(merged)
        });
        return sendJson(res, 201, { ok: true, community: normalizedComm, communities: merged });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  // 커뮤니티 삭제
  const commDeleteMatch = parsedUrl.pathname.match(/^\/api\/communities\/([^/]+)$/);
  if (req.method === "DELETE" && commDeleteMatch) {
    const commId = String(decodeURIComponent(commDeleteMatch[1]));
    (async () => {
      try {
        const [commsRes, delRes] = await Promise.all([
          fetch(`${COMMUNITIES_DB_URL}?_t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${DELETED_COMMS_DB_URL}?_t=${Date.now()}`, { cache: "no-store" })
        ]);
        const existing = commsRes.ok ? await commsRes.json().catch(() => []) : [];
        const deleted = delRes.ok ? await delRes.json().catch(() => []) : [];
        const nextDeleted = Array.from(new Set([...(Array.isArray(deleted) ? deleted.map(String) : []), commId]));
        const nextComms = (Array.isArray(existing) ? existing : []).filter((c) => c && String(c.id) !== commId);
        await Promise.all([
          fetch(DELETED_COMMS_DB_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextDeleted)
          }),
          fetch(COMMUNITIES_DB_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextComms)
          })
        ]);
        return sendJson(res, 200, { ok: true, deletedId: commId });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    })();
    return;
  }

  const roomJoinMatch = parsedUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
  if (req.method === "POST" && roomJoinMatch) {
    const commId = decodeURIComponent(roomJoinMatch[1]);
    readJsonBody(req)
      .then(async (body) => {
        const userId = String(body.userId || "").trim();
        if (!userId) return sendJson(res, 400, { ok: false, error: "userId가 필요합니다." });
        const map = await getRoomMembersMap();
        if (!map[commId] || typeof map[commId] !== "object") map[commId] = {};
        // 이미 입장 기록이 있으면 enteredAt(joined_at)을 덮어쓰지 않고 기존 입장 시점 유지
        if (!map[commId][userId]) {
          map[commId][userId] = body.enteredAt || body.joinedAt || new Date().toISOString();
          await saveRoomMembersMap(map);
        }
        return sendJson(res, 200, {
          ok: true,
          commId,
          userId,
          enteredAt: map[commId][userId],
          joinedAt: map[commId][userId]
        });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  const roomLeaveMatch = parsedUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/leave$/);
  if (req.method === "DELETE" && roomLeaveMatch) {
    const commId = decodeURIComponent(roomLeaveMatch[1]);
    readJsonBody(req)
      .then(async (body) => {
        const userId = String(body.userId || parsedUrl.searchParams.get("userId") || "").trim();
        if (!userId) return sendJson(res, 400, { ok: false, error: "userId가 필요합니다." });
        const map = await getRoomMembersMap();
        if (map[commId] && map[commId][userId]) {
          delete map[commId][userId];
          await saveRoomMembersMap(map);
        }
        return sendJson(res, 200, { ok: true, commId, userId });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  // 메시지 이모지 공감(리액션) 토글 및 영구 저장
  const reactionMatch = parsedUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/messages\/([^/]+)\/reaction$/);
  if (req.method === "POST" && reactionMatch) {
    const commId = decodeURIComponent(reactionMatch[1]);
    const msgId = decodeURIComponent(reactionMatch[2]);
    readJsonBody(req)
      .then(async (body) => {
        const userId = String(body.userId || "").trim();
        const emoji = String(body.emoji || "").trim();
        if (!userId || !emoji) {
          return sendJson(res, 400, { ok: false, error: "userId와 emoji가 필요합니다." });
        }
        const msgKeyUrl = `${ROOM_MSG_DB_PREFIX}${encodeURIComponent(commId)}`;
        const msgRes = await fetch(`${msgKeyUrl}?_t=${Date.now()}`, { cache: "no-store" });
        const allMsgs = msgRes.ok ? await msgRes.json().catch(() => []) : [];
        const list = Array.isArray(allMsgs) ? allMsgs : [];
        const idx = list.findIndex((m) => m && String(m.id) === String(msgId));
        if (idx < 0) {
          return sendJson(res, 404, { ok: false, error: "메시지를 찾을 수 없습니다." });
        }
        const msg = list[idx];
        const reactions = Array.isArray(msg.reactions) ? msg.reactions.map((r) => ({ ...r, userIds: [...(r.userIds || [])] })) : [];
        const rIdx = reactions.findIndex((r) => r.emoji === emoji);
        if (rIdx >= 0) {
          const exists = reactions[rIdx].userIds.includes(userId);
          reactions[rIdx].userIds = exists
            ? reactions[rIdx].userIds.filter((id) => id !== userId)
            : [...reactions[rIdx].userIds, userId];
          if (reactions[rIdx].userIds.length === 0) {
            reactions.splice(rIdx, 1);
          }
        } else {
          reactions.push({ emoji, userIds: [userId] });
        }
        msg.reactions = reactions;
        msg.reactionsUpdatedAt = Date.now();
        list[idx] = msg;
        await fetch(msgKeyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(list)
        });
        return sendJson(res, 200, {
          ok: true,
          communityId: commId,
          messageId: msgId,
          reactions,
          reactionsUpdatedAt: msg.reactionsUpdatedAt
        });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  const roomMsgsMatch = parsedUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (req.method === "GET" && roomMsgsMatch) {
    const commId = decodeURIComponent(roomMsgsMatch[1]);
    const userId = String(parsedUrl.searchParams.get("userId") || "").trim();
    if (!userId) return sendJson(res, 400, { ok: false, error: "userId 쿼리가 필요합니다." });
    (async () => {
      try {
        const map = await getRoomMembersMap();
        const enteredAt = map[commId]?.[userId] || null;
        if (!enteredAt) {
          return sendJson(res, 200, { ok: true, enteredAt: null, joinedAt: null, messages: [] });
        }
        const enteredMs = Date.parse(enteredAt);
        const msgRes = await fetch(`${ROOM_MSG_DB_PREFIX}${encodeURIComponent(commId)}?_t=${Date.now()}`, { cache: "no-store" });
        const allMsgs = msgRes.ok ? await msgRes.json().catch(() => []) : [];
        const filtered = Array.isArray(allMsgs) && !Number.isNaN(enteredMs)
          ? allMsgs.filter((m) => parseMessageTimestampMs(m) >= enteredMs)
          : [];
        return sendJson(res, 200, { ok: true, enteredAt, joinedAt: enteredAt, messages: filtered });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    })();
    return;
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
        const title = String(body.title || "").trim();
        const content = String(body.content || "").trim();
        if (!title || !content) {
          return sendJson(res, 400, { ok: false, error: "제목과 상세 내용을 입력해 주세요." });
        }

        const inquiry = {
          id: body.id || `inq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          category: String(body.category || "일반 문의"),
          replyEmail: String(body.replyEmail || "").trim(),
          title,
          content,
          senderInfo: String(body.senderInfo || "방문자"),
          createdAt: body.createdAt || new Date().toISOString(),
          mailStatus: "pending"
        };

        // 1. 안전장치: 메일 발송 전에 DB 백업을 무조건 먼저 실행
        const dbSaved = await backupInquiryToDb(inquiry);

        // 2. Resend SDK(HTTPS 포트 443)로 실제 메일 발송
        const mailResult = await sendViaResendSdk(inquiry);
        console.log(`[Support Mail Sent] id=${mailResult?.id} to=${ADMIN_EMAIL} inquiryId=${inquiry.id}`);

        return sendJson(res, 200, {
          ok: true,
          id: mailResult?.id,
          inquiryId: inquiry.id,
          dbSaved
        });
      } catch (err) {
        // 실패 시 정확한 원인(인증 실패, 환경변수 누락, 도메인 제한 등)을 서버 로그에 상세 출력
        console.error("[Support Mail Error]", {
          code: err.code || err.name || "UNKNOWN_ERROR",
          statusCode: err.statusCode || null,
          message: err.message,
          adminEmail: ADMIN_EMAIL,
          fromEmail: FROM_EMAIL,
          hasResendKey: !!RESEND_API_KEY,
          stack: err.stack
        });
        return sendJson(res, 500, {
          ok: false,
          error: err.message || "메일 발송 중 서버 오류가 발생했습니다.",
          code: err.code || err.name || "MAIL_SEND_FAILED"
        });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[Mail Server] Listening on port ${PORT}`);
  console.log(`[Mail Server] Recipient: ${ADMIN_EMAIL}, From: ${FROM_EMAIL}, Resend Key: ${RESEND_API_KEY ? "SET" : "MISSING"}`);
});
