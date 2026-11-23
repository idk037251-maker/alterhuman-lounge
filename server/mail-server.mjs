import http from "node:http";

const PORT = Number(process.env.PORT || 3001);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "idk037251@gmail.com").trim();
const LEGACY_NS = ["alter", "human"].join("");
const CLOUD_DB_URL = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_cloud_inquiries_v1`;
const ROOM_MEMBERS_DB_URL = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_cloud_room_members_v1`;
const ROOM_MSG_DB_PREFIX = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_room_msgs_`;
const COMMUNITIES_DB_URL = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_cloud_communities_v1`;
const DELETED_COMMS_DB_URL = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_cloud_deleted_comms_v1`;
const REACTIONS_DB_URL = `https://kvdb.io/UJi5qrxjVL5oMcMYSXCvLC/${LEGACY_NS}_cloud_reactions_v1`;

// 서버 시작 시점에 공감(message_reactions) 스토어 및 스키마가 없으면 자동 생성/초기화
async function ensureReactionSchemaOnBoot() {
  try {
    const res = await fetch(`${REACTIONS_DB_URL}?_t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      await fetch(REACTIONS_DB_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, initializedAt: new Date().toISOString(), reactionsByMsg: {} })
      });
    }
    console.log("[숲톡 DB Auto-Migration] message_reactions table/store verified on startup.");
  } catch (err) {
    console.warn("[숲톡 DB Auto-Migration] Deferred schema init:", err.message);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Admin-Email, X-Admin-User"
  });
  res.end(JSON.stringify(data));
}

const SUPER_ADMIN_ALLOWED = new Set(["idk037251@gmail.com", "idk037251", "loon", "우엉김밥"]);

function isSuperAdminAuthorized(req, parsedUrl, body = {}) {
  const candidates = [
    req.headers["x-admin-email"],
    req.headers["x-admin-user"],
    parsedUrl?.searchParams?.get("adminEmail"),
    parsedUrl?.searchParams?.get("adminUser"),
    body?.adminEmail,
    body?.adminUser
  ]
    .filter(Boolean)
    .map((v) => String(v).trim().toLowerCase());
  return candidates.some((c) => SUPER_ADMIN_ALLOWED.has(c));
}

async function getInquiriesFromDb() {
  const getRes = await fetch(`${CLOUD_DB_URL}?_t=${Date.now()}`, { cache: "no-store" });
  if (!getRes.ok) return [];
  const parsed = await getRes.json().catch(() => []);
  return Array.isArray(parsed) ? parsed : [];
}

async function saveInquiriesToDb(list) {
  const putRes = await fetch(CLOUD_DB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(list)
  });
  return putRes.ok;
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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      adminEmail: ADMIN_EMAIL,
      mode: "db-only-inbox",
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

  // 최고 관리자(idk037251@gmail.com) 전용 DB 저장소 조회/상태변경/삭제 API (비권한 접근 시 403 Forbidden)
  if (req.method === "GET" && parsedUrl.pathname === "/api/admin/inquiries") {
    if (!isSuperAdminAuthorized(req, parsedUrl)) {
      return sendJson(res, 403, { ok: false, error: "403 Forbidden: 최고 관리자(idk037251@gmail.com) 권한이 필요합니다." });
    }
    (async () => {
      try {
        const list = await getInquiriesFromDb();
        const sorted = list
          .filter((x) => x && x.id)
          .map((x) => ({ ...x, status: x.status === "처리 완료" ? "처리 완료" : "접수됨" }))
          .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        return sendJson(res, 200, { ok: true, inquiries: sorted });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    })();
    return;
  }

  const adminInqMatch = parsedUrl.pathname.match(/^\/api\/admin\/inquiries\/([^/]+)$/);
  if (adminInqMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const targetId = decodeURIComponent(adminInqMatch[1]);
    readJsonBody(req)
      .then(async (body) => {
        if (!isSuperAdminAuthorized(req, parsedUrl, body)) {
          return sendJson(res, 403, { ok: false, error: "403 Forbidden: 최고 관리자(idk037251@gmail.com) 권한이 필요합니다." });
        }
        const list = await getInquiriesFromDb();
        if (req.method === "DELETE") {
          const filtered = list.filter((x) => x && String(x.id) !== String(targetId));
          await saveInquiriesToDb(filtered);
          return sendJson(res, 200, { ok: true, deletedId: targetId, inquiries: filtered });
        }
        const updated = list.map((x) => {
          if (x && String(x.id) === String(targetId)) {
            const nextStatus = body.status || (x.status === "처리 완료" ? "접수됨" : "처리 완료");
            return { ...x, status: nextStatus, updatedAt: new Date().toISOString() };
          }
          return x;
        });
        await saveInquiriesToDb(updated);
        return sendJson(res, 200, { ok: true, id: targetId, inquiries: updated });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/support") {
    readJsonBody(req)
      .then(async (body) => {
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
          status: body.status === "처리 완료" ? "처리 완료" : "접수됨"
        };

        // 외부 이메일 발송 없이 오직 DB(관리자 접수함)에만 안전하게 영구 저장
        const dbSaved = await backupInquiryToDb(inquiry);
        return sendJson(res, 200, {
          ok: true,
          inquiryId: inquiry.id,
          dbSaved,
          message: "문의/신고가 정상적으로 접수되었습니다."
        });
      })
      .catch((err) => {
        console.error("[Support DB Save Error]", err);
        return sendJson(res, 500, {
          ok: false,
          error: "문의/신고 DB 저장 중 오류가 발생했습니다."
        });
      });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[숲톡 Server] Listening on port ${PORT}`);
  console.log(`[숲톡 Server] Super Admin DB Inbox: ${ADMIN_EMAIL}`);
  ensureReactionSchemaOnBoot();
});
