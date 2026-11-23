-- 숲톡 (SoopTalk) Database Schema & Migration
-- Tracks public communities, per-user room entry timestamps (entered_at / joined_at), messages, and emoji reactions.

CREATE TABLE IF NOT EXISTS communities (
  id VARCHAR(128) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  category VARCHAR(64),
  created_by VARCHAR(128),
  created_by_id VARCHAR(128),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Public communities query (all accounts see the same public community list; no user_id filter):
-- SELECT * FROM communities ORDER BY created_at DESC;

CREATE TABLE IF NOT EXISTS room_members (
  community_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (community_id, user_id)
);

-- Migration for existing deployments without joined_at
ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(128) PRIMARY KEY,
  community_id VARCHAR(128) NOT NULL,
  channel_id VARCHAR(64) NOT NULL DEFAULT 'general',
  sender_id VARCHAR(128) NOT NULL,
  content TEXT,
  attachment_url TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  reactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reactions_updated_at BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Auto-migration for existing messages table on deployment servers
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reactions_updated_at BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_comm_created_at
  ON messages (community_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id VARCHAR(128) NOT NULL,
  community_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS support_inquiries (
  id VARCHAR(128) PRIMARY KEY,
  category VARCHAR(64) NOT NULL,
  reply_email VARCHAR(255),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  sender_info VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT '접수됨',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE support_inquiries
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT '접수됨';

-- Query pattern used when loading room history for a specific user:
-- SELECT m.*
-- FROM messages m
-- INNER JOIN room_members rm
--   ON rm.community_id = m.community_id
--  AND rm.user_id = $2
-- WHERE m.community_id = $1
--   AND m.created_at >= rm.joined_at
-- ORDER BY m.created_at ASC;
