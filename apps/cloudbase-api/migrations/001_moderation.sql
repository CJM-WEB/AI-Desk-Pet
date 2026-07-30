BEGIN;

-- 投稿主表只保存查询令牌的 SHA-256 哈希，不保存原始令牌。
CREATE TABLE submissions (
  id text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'resource',
  title text,
  body text,
  status text NOT NULL DEFAULT 'uploading'
    CHECK (status IN (
      'uploading',
      'system_reviewing',
      'manual_review_pending',
      'published',
      'auto_rejected',
      'admin_rejected',
      'deleted_quarantined',
      'purged'
    )),
  status_version bigint NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  status_token_hash char(64) NOT NULL UNIQUE,
  captcha_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  public_reason varchar(500),
  auto_rejection_reason varchar(500),
  moderation_lease_until timestamptz,
  cleanup_lease_until timestamptz,
  published_at timestamptz,
  rejected_at timestamptz,
  quarantined_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id bigserial PRIMARY KEY,
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size >= 0),
  actual_size bigint CHECK (actual_size >= 0),
  sha256 char(64),
  mime_type text,
  signature_valid boolean,
  role text NOT NULL CHECK (role IN ('cover', 'package', 'derived')),
  scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'safe', 'unsafe', 'failed')),
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_results (
  id bigserial PRIMARY KEY,
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  provider text NOT NULL,
  rule_version text NOT NULL,
  suggestion text NOT NULL CHECK (suggestion IN ('Pass', 'Review', 'Block')),
  label text NOT NULL,
  score double precision,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_logs (
  id bigserial PRIMARY KEY,
  submission_id text NOT NULL REFERENCES submissions(id),
  admin_id text NOT NULL,
  action text NOT NULL,
  before_status text NOT NULL,
  after_status text NOT NULL,
  reason varchar(500) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public_engagement (
  submission_id text PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  like_count bigint NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 私有桶不配置 anon/authenticated 策略，仅由 service_role 访问。
INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-pet-private', 'ai-pet-private', false)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = false;

CREATE INDEX submissions_moderation_queue_idx
  ON submissions (created_at, id)
  WHERE status = 'system_reviewing';
CREATE INDEX submissions_public_list_idx
  ON submissions (published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX submissions_purge_queue_idx
  ON submissions (purge_after, id)
  WHERE purge_after IS NOT NULL AND status <> 'purged';
CREATE INDEX moderation_results_submission_idx
  ON moderation_results (submission_id, created_at);

-- 投稿主记录和两项资产声明必须在同一事务中创建，禁止留下无令牌残记录。
CREATE FUNCTION create_submission(
  p_submission jsonb,
  p_assets jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_submission) <> 'object'
    OR jsonb_typeof(p_assets) <> 'array'
    OR jsonb_array_length(p_assets) <> 2 THEN
    RAISE EXCEPTION 'invalid submission payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO submissions (id, kind, title, body, status_token_hash)
  VALUES (
    p_submission ->> 'id',
    p_submission ->> 'kind',
    p_submission ->> 'title',
    p_submission ->> 'body',
    p_submission ->> 'status_token_hash'
  )
  RETURNING * INTO v_submission;

  INSERT INTO assets (
    submission_id,
    object_key,
    original_name,
    declared_size,
    mime_type,
    role
  )
  SELECT
    v_submission.id,
    asset.storage_key,
    asset.file_name,
    asset.declared_bytes,
    asset.content_type,
    asset.role
  FROM jsonb_to_recordset(p_assets) AS asset(
    role text,
    storage_key text,
    file_name text,
    declared_bytes bigint,
    content_type text
  );

  RETURN to_jsonb(v_submission);
END;
$$;

-- 领取审核任务必须在数据库事务内完成锁定和租约写入。
CREATE FUNCTION claim_moderation_jobs(
  p_limit integer,
  p_lease_until timestamptz
)
RETURNS SETOF submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid moderation claim limit' USING ERRCODE = '22023';
  END IF;

  IF p_lease_until <= now() THEN
    RAISE EXCEPTION 'moderation lease must expire in the future'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM submissions
    WHERE status = 'system_reviewing'
      AND (
        moderation_lease_until IS NULL
        OR moderation_lease_until <= now()
      )
    ORDER BY created_at, id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE submissions AS submission
  SET moderation_lease_until = p_lease_until,
      updated_at = now()
  FROM candidates
  WHERE submission.id = candidates.id
  RETURNING submission.*;
END;
$$;

-- 管理员动作由数据库原子处理乐观锁、幂等结果和审计记录。
CREATE FUNCTION apply_admin_action(
  p_submission_id text,
  p_admin_id text,
  p_action text,
  p_next_status text,
  p_expected_version bigint,
  p_idempotency_key text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing admin_audit_logs%ROWTYPE;
  v_previous_status text;
  v_request_payload jsonb;
  v_submission submissions%ROWTYPE;
  v_result jsonb;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  v_request_payload := jsonb_build_object(
    'submissionId', p_submission_id,
    'adminId', p_admin_id,
    'action', p_action,
    'nextStatus', p_next_status,
    'expectedVersion', p_expected_version,
    'reason', p_reason
  );

  -- 同一幂等键串行化，避免并发重复请求先后越过查询。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  SELECT *
  INTO v_existing
  FROM admin_audit_logs
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_payload <> v_request_payload THEN
      RAISE EXCEPTION 'idempotency key reused with different input'
        USING ERRCODE = '22023';
    END IF;

    RETURN v_existing.result_snapshot || jsonb_build_object('replayed', true);
  END IF;

  SELECT status
  INTO v_previous_status
  FROM submissions
  WHERE id = p_submission_id;

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      published_at = CASE
        WHEN p_next_status = 'published' THEN COALESCE(published_at, now())
        ELSE published_at
      END,
      updated_at = now()
  WHERE id = p_submission_id
    AND status_version = p_expected_version
  RETURNING * INTO v_submission;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission version conflict' USING ERRCODE = '40001';
  END IF;

  v_result := jsonb_build_object(
    'submission', to_jsonb(v_submission),
    'replayed', false
  );

  INSERT INTO admin_audit_logs (
    submission_id,
    admin_id,
    action,
    before_status,
    after_status,
    reason,
    idempotency_key,
    request_payload,
    result_snapshot
  )
  VALUES (
    p_submission_id,
    p_admin_id,
    p_action,
    v_previous_status,
    p_next_status,
    p_reason,
    p_idempotency_key,
    v_request_payload,
    v_result
  );

  RETURN v_result;
END;
$$;

-- 默认拒绝所有非服务端角色；公开内容必须经云函数裁剪。
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE submissions FROM anon, authenticated;
GRANT ALL ON TABLE submissions TO service_role;

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE assets FROM anon, authenticated;
GRANT ALL ON TABLE assets TO service_role;

ALTER TABLE moderation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_results FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE moderation_results FROM anon, authenticated;
GRANT ALL ON TABLE moderation_results TO service_role;

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin_audit_logs FROM anon, authenticated;
GRANT ALL ON TABLE admin_audit_logs TO service_role;

ALTER TABLE public_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_engagement FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public_engagement FROM anon, authenticated;
GRANT ALL ON TABLE public_engagement TO service_role;

REVOKE ALL ON SEQUENCE assets_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE assets_id_seq TO service_role;
REVOKE ALL ON SEQUENCE moderation_results_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE moderation_results_id_seq TO service_role;
REVOKE ALL ON SEQUENCE admin_audit_logs_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE admin_audit_logs_id_seq TO service_role;

REVOKE ALL ON FUNCTION create_submission(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_submission(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION claim_moderation_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_moderation_jobs(integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) TO service_role;

COMMIT;
