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
  moderation_attempts integer NOT NULL DEFAULT 0
    CHECK (moderation_attempts >= 0),
  moderation_next_retry_at timestamptz,
  moderation_last_error varchar(200),
  moderation_alerted_at timestamptz,
  cleanup_lease_until timestamptz,
  cleanup_started_at timestamptz,
  published_at timestamptz,
  rejected_at timestamptz,
  quarantined_at timestamptz,
  purge_after timestamptz,
  pre_quarantine_status text
    CHECK (pre_quarantine_status IS NULL OR pre_quarantine_status IN (
      'uploading',
      'system_reviewing',
      'manual_review_pending',
      'published',
      'auto_rejected',
      'admin_rejected'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id bigserial PRIMARY KEY,
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size > 0),
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

-- 安全状态只保存不可逆哈希，避免持久化原始票据、IP 或 User-Agent。
CREATE TABLE captcha_replays (
  ticket_hash char(64) PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE TABLE abuse_counters (
  scope text NOT NULL,
  fingerprint_hash char(64) NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, fingerprint_hash, window_start)
);

CREATE TABLE engagement_votes (
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  fingerprint_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, fingerprint_hash)
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
CREATE INDEX submissions_incomplete_upload_idx
  ON submissions (created_at, id)
  WHERE status = 'uploading';
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

  INSERT INTO submissions (
    id,
    kind,
    title,
    body,
    status_token_hash,
    purge_after
  )
  VALUES (
    p_submission ->> 'id',
    p_submission ->> 'kind',
    p_submission ->> 'title',
    p_submission ->> 'body',
    p_submission ->> 'status_token_hash',
    now() + interval '3 days'
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

-- 上传完成必须与清理栅栏原子互斥，清理一旦开始就不能重新进入审核。
CREATE FUNCTION complete_submission_upload(
  p_submission_id text,
  p_assets jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
  v_updated integer;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_assets) <> 'array'
    OR jsonb_array_length(p_assets) <> 2 THEN
    RAISE EXCEPTION 'invalid completed assets' USING ERRCODE = 'P1002';
  END IF;

  UPDATE assets AS asset
  SET actual_size = provided.actual_bytes,
      mime_type = provided.content_type,
      signature_valid = true,
      updated_at = now()
  FROM jsonb_to_recordset(p_assets) AS provided(
    role text,
    storage_key text,
    actual_bytes bigint,
    content_type text
  )
  WHERE asset.submission_id = p_submission_id
    AND asset.role = provided.role
    AND asset.object_key = provided.storage_key
    AND asset.declared_size = provided.actual_bytes
    AND asset.mime_type = provided.content_type
    AND provided.role IN ('cover', 'package')
    AND provided.actual_bytes > 0;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 2 THEN
    RAISE EXCEPTION 'completed assets mismatch' USING ERRCODE = 'P1002';
  END IF;

  UPDATE submissions
  SET status = 'system_reviewing',
      status_version = status_version + 1,
      purge_after = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status = 'uploading'
    AND cleanup_started_at IS NULL
  RETURNING * INTO v_submission;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload cannot be finalized' USING ERRCODE = 'P1002';
  END IF;
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

  IF p_limit < 1 OR p_limit > 3 THEN
    RAISE EXCEPTION 'invalid moderation claim limit' USING ERRCODE = '22023';
  END IF;

  IF p_lease_until <= now()
    OR p_lease_until > now() + interval '10 minutes 5 seconds' THEN
    RAISE EXCEPTION 'moderation lease must expire in the future'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM submissions
    WHERE status = 'system_reviewing'
      AND moderation_attempts < 5
      AND (
        moderation_next_retry_at IS NULL
        OR moderation_next_retry_at <= now()
      )
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
      status_version = submission.status_version + 1,
      updated_at = now()
  FROM candidates
  WHERE submission.id = candidates.id
  RETURNING submission.*;
END;
$$;

-- 审核证据与最终决策在同一事务中写入，并用状态版本阻止过期工作器覆盖。
CREATE FUNCTION apply_moderation_decision(
  p_submission_id text,
  p_expected_version bigint,
  p_next_status text,
  p_results jsonb,
  p_risk_summary jsonb,
  p_auto_rejection_reason text
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

  IF p_next_status NOT IN ('manual_review_pending', 'auto_rejected')
    OR jsonb_typeof(p_results) <> 'array'
    OR jsonb_array_length(p_results) > 2500
    OR jsonb_typeof(p_risk_summary) <> 'object' THEN
    RAISE EXCEPTION 'invalid moderation decision'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_submission.status <> 'system_reviewing'
    OR v_submission.status_version <> p_expected_version THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  INSERT INTO moderation_results (
    submission_id,
    kind,
    provider,
    rule_version,
    suggestion,
    label,
    score,
    evidence,
    requested_at,
    completed_at,
    error_message
  )
  SELECT
    p_submission_id,
    result.kind,
    result.provider,
    result.rule_version,
    result.suggestion,
    result.label,
    result.score,
    result.evidence,
    result.requested_at,
    result.completed_at,
    result.error_message
  FROM jsonb_to_recordset(p_results) AS result(
    kind text,
    provider text,
    rule_version text,
    suggestion text,
    label text,
    score double precision,
    evidence jsonb,
    requested_at timestamptz,
    completed_at timestamptz,
    error_message text
  );

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      risk_summary = p_risk_summary,
      auto_rejection_reason = CASE
        WHEN p_next_status = 'auto_rejected'
          THEN left(p_auto_rejection_reason, 500)
        ELSE NULL
      END,
      rejected_at = CASE
        WHEN p_next_status = 'auto_rejected' THEN now()
        ELSE NULL
      END,
      purge_after = CASE
        WHEN p_next_status = 'auto_rejected' THEN now() + interval '3 days'
        ELSE NULL
      END,
      moderation_lease_until = NULL,
      moderation_next_retry_at = NULL,
      moderation_last_error = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status = 'system_reviewing'
    AND status_version = p_expected_version;

  RETURN jsonb_build_object('applied', true);
END;
$$;

-- 失败只增加持久化尝试次数并释放租约；第五次仍保持隐藏并设置告警标记。
CREATE FUNCTION record_moderation_failure(
  p_submission_id text,
  p_expected_version bigint,
  p_error_summary text,
  p_results jsonb
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

  IF p_error_summary IS NULL
    OR length(p_error_summary) > 200
    OR jsonb_typeof(p_results) <> 'array'
    OR jsonb_array_length(p_results) > 2500 THEN
    RAISE EXCEPTION 'invalid moderation failure'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_submission.status <> 'system_reviewing'
    OR v_submission.status_version <> p_expected_version THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  INSERT INTO moderation_results (
    submission_id,
    kind,
    provider,
    rule_version,
    suggestion,
    label,
    score,
    evidence,
    requested_at,
    completed_at,
    error_message
  )
  SELECT
    p_submission_id,
    result.kind,
    result.provider,
    result.rule_version,
    result.suggestion,
    result.label,
    result.score,
    result.evidence,
    result.requested_at,
    result.completed_at,
    result.error_message
  FROM jsonb_to_recordset(p_results) AS result(
    kind text,
    provider text,
    rule_version text,
    suggestion text,
    label text,
    score double precision,
    evidence jsonb,
    requested_at timestamptz,
    completed_at timestamptz,
    error_message text
  );

  UPDATE submissions
  SET moderation_attempts = moderation_attempts + 1,
      status_version = status_version + 1,
      moderation_next_retry_at = now()
        + make_interval(secs => LEAST(
          3600,
          60 * power(2, moderation_attempts)::integer
        )),
      moderation_last_error = left(p_error_summary, 200),
      moderation_alerted_at = CASE
        WHEN moderation_attempts >= 4
          THEN COALESCE(moderation_alerted_at, now())
        ELSE moderation_alerted_at
      END,
      moderation_lease_until = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status = 'system_reviewing'
    AND status_version = p_expected_version;

  RETURN jsonb_build_object('applied', true);
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
  v_cleanup_started_at timestamptz;
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

  SELECT status, cleanup_started_at
  INTO v_previous_status, v_cleanup_started_at
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cleanup_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'submission cleanup already started' USING ERRCODE = '40001';
  END IF;

  SELECT *
  INTO v_existing
  FROM admin_audit_logs
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_payload <> v_request_payload THEN
      RAISE EXCEPTION 'idempotency key reused with different input'
        USING ERRCODE = 'P1001';
    END IF;

    RETURN v_existing.result_snapshot || jsonb_build_object('replayed', true);
  END IF;

  IF NOT (
    (p_action = 'approve'
      AND v_previous_status IN ('manual_review_pending', 'auto_rejected')
      AND p_next_status = 'published')
    OR (p_action = 'reject'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'admin_rejected')
    OR (p_action = 'move_to_manual'
      AND v_previous_status = 'auto_rejected'
      AND p_next_status = 'manual_review_pending')
    OR (p_action = 'delete'
      AND v_previous_status NOT IN ('purged', 'deleted_quarantined')
      AND p_next_status = 'deleted_quarantined')
    OR (p_action = 'restore'
      AND v_previous_status = 'deleted_quarantined'
      AND p_next_status = (
        SELECT pre_quarantine_status
        FROM submissions
        WHERE id = p_submission_id
      ))
  ) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  IF p_action = 'approve'
    AND (SELECT kind FROM submissions WHERE id = p_submission_id) = 'shared_package'
    AND NOT EXISTS (
      SELECT 1
      FROM moderation_results AS result
      JOIN assets AS asset
        ON asset.submission_id = result.submission_id
       AND asset.role = 'package'
      WHERE result.submission_id = p_submission_id
        AND result.kind = 'package_scan'
        AND result.provider = 'isolated-scanner'
        AND result.suggestion = 'Pass'
        AND result.evidence ->> 'packageStorageKey' = asset.object_key
        AND result.evidence ->> 'packageSizeBytes' = asset.actual_size::text
        AND result.evidence ->> 'scanCode' = 'CHARACTER_PACKAGE_SCAN_PASSED'
    ) THEN
    RAISE EXCEPTION 'technical scan required' USING ERRCODE = 'P1003';
  END IF;

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      published_at = CASE
        WHEN p_next_status = 'published' THEN COALESCE(published_at, now())
        ELSE published_at
      END,
      public_reason = CASE
        WHEN p_action = 'reject' THEN left(p_reason, 500)
        WHEN p_action IN ('approve', 'move_to_manual') THEN NULL
        ELSE public_reason
      END,
      rejected_at = CASE
        WHEN p_action = 'reject' THEN now()
        WHEN p_action IN ('approve', 'move_to_manual') THEN NULL
        ELSE rejected_at
      END,
      quarantined_at = CASE
        WHEN p_action = 'delete' THEN now()
        WHEN p_action = 'restore' THEN NULL
        ELSE quarantined_at
      END,
      purge_after = CASE
        WHEN p_action IN ('reject', 'delete') THEN now() + interval '3 days'
        WHEN p_action = 'restore'
          AND p_next_status IN ('auto_rejected', 'admin_rejected')
          THEN now() + interval '3 days'
        WHEN p_action IN ('approve', 'move_to_manual', 'restore') THEN NULL
        ELSE purge_after
      END,
      pre_quarantine_status = CASE
        WHEN p_action = 'delete' THEN v_previous_status
        ELSE pre_quarantine_status
      END,
      updated_at = now()
  WHERE id = p_submission_id
    AND status_version = p_expected_version
  RETURNING * INTO v_submission;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission version conflict' USING ERRCODE = '40001';
  END IF;

  IF p_next_status = 'published' THEN
    INSERT INTO public_engagement (submission_id)
    VALUES (p_submission_id)
    ON CONFLICT (submission_id) DO NOTHING;
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

-- 清理任务同时领取三天隔离到期记录和超过一小时的残缺上传。
CREATE FUNCTION claim_cleanup_jobs(
  p_limit integer,
  p_lease_until timestamptz
)
RETURNS SETOF jsonb
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
  IF p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 100
    OR p_lease_until IS NULL
    OR p_lease_until <= now()
    OR p_lease_until > now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'invalid cleanup claim' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT submission.id
    FROM submissions AS submission
    WHERE submission.status IN (
        'auto_rejected',
        'admin_rejected',
        'deleted_quarantined',
        'uploading'
      )
      AND (
        submission.cleanup_lease_until IS NULL
        OR submission.cleanup_lease_until <= now()
      )
      AND (
        submission.purge_after <= now()
        OR (
          submission.status = 'uploading'
          AND (
            submission.cleanup_started_at IS NOT NULL
            OR submission.updated_at <= now() - interval '1 hour'
          )
        )
      )
    ORDER BY COALESCE(submission.purge_after, submission.updated_at), submission.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE submissions AS submission
    SET cleanup_lease_until = p_lease_until,
        cleanup_started_at = COALESCE(cleanup_started_at, now()),
        status_version = status_version + 1,
        updated_at = now()
    FROM candidates
    WHERE submission.id = candidates.id
    RETURNING submission.*
  )
  SELECT to_jsonb(claimed) || jsonb_build_object(
    'assets',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'role', asset.role,
        'object_key', asset.object_key,
        'original_name', asset.original_name,
        'declared_size', asset.declared_size,
        'actual_size', asset.actual_size,
        'mime_type', asset.mime_type
      ) ORDER BY asset.id)
      FROM assets AS asset
      WHERE asset.submission_id = claimed.id
    ), '[]'::jsonb)
  )
  FROM claimed;
END;
$$;

-- 私有对象删除成功后，才清空正文、对象键和详细审核证据。
CREATE FUNCTION mark_submission_purged(
  p_submission_id text,
  p_expected_version bigint
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

  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_submission.status_version <> p_expected_version
    OR v_submission.cleanup_lease_until IS NULL
    OR v_submission.cleanup_started_at IS NULL
    OR NOT (
      (
        v_submission.status IN (
          'auto_rejected',
          'admin_rejected',
          'deleted_quarantined'
        )
        AND v_submission.purge_after <= now()
      )
      OR (
        v_submission.status = 'uploading'
        AND v_submission.cleanup_started_at IS NOT NULL
      )
    ) THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  DELETE FROM assets WHERE submission_id = p_submission_id;
  UPDATE moderation_results
  SET evidence = '{}'::jsonb,
      error_message = NULL
  WHERE submission_id = p_submission_id;
  UPDATE admin_audit_logs
  SET result_snapshot = jsonb_build_object(
    'submission',
    jsonb_build_object('id', p_submission_id, 'status', 'purged'),
    'replayed',
    false
  )
  WHERE submission_id = p_submission_id;
  UPDATE submissions
  SET title = NULL,
      body = NULL,
      status = 'purged',
      status_version = status_version + 1,
      risk_summary = jsonb_build_object('purged', true),
      public_reason = NULL,
      auto_rejection_reason = NULL,
      cleanup_lease_until = NULL,
      purge_after = NULL,
      pre_quarantine_status = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status_version = p_expected_version;
  RETURN jsonb_build_object('applied', true);
END;
$$;

-- 腾讯验票成功后再原子登记票据哈希，数据库冲突即为本应用内重放。
CREATE FUNCTION consume_captcha_ticket(
  p_ticket_hash char(64),
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_ticket_hash !~ '^[a-f0-9]{64}$' OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid captcha replay input' USING ERRCODE = '22023';
  END IF;

  DELETE FROM captcha_replays WHERE expires_at <= now();
  INSERT INTO captcha_replays (ticket_hash, expires_at)
  VALUES (p_ticket_hash, p_expires_at)
  ON CONFLICT (ticket_hash) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('consumed', v_inserted = 1);
END;
$$;

-- 固定窗口计数完全在数据库内原子递增，并返回当前窗口剩余秒数。
CREATE FUNCTION consume_abuse_limit(
  p_scope text,
  p_fingerprint_hash char(64),
  p_maximum integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_expires_at timestamptz;
  v_count integer;
  v_retry integer;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_fingerprint_hash !~ '^[a-f0-9]{64}$'
    OR NOT (
      (p_scope = 'submission_prepare' AND p_maximum = 5 AND p_window_seconds = 600)
      OR (p_scope = 'status_query' AND p_maximum = 30 AND p_window_seconds = 60)
      OR (
        p_scope ~ '^(like|download):[A-Za-z0-9_-]{1,128}$'
        AND p_maximum = 10
        AND p_window_seconds = 60
      )
    ) THEN
    RAISE EXCEPTION 'invalid abuse limit input' USING ERRCODE = '22023';
  END IF;

  v_window_start := to_timestamp(
    floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds
  );
  v_expires_at := v_window_start + make_interval(secs => p_window_seconds);
  DELETE FROM abuse_counters WHERE expires_at <= v_now;

  INSERT INTO abuse_counters (
    scope,
    fingerprint_hash,
    window_start,
    count,
    expires_at
  )
  VALUES (
    p_scope,
    p_fingerprint_hash,
    v_window_start,
    1,
    v_expires_at
  )
  ON CONFLICT (scope, fingerprint_hash, window_start)
  DO UPDATE SET count = abuse_counters.count + 1
  WHERE abuse_counters.count < p_maximum
  RETURNING count INTO v_count;

  IF v_count IS NOT NULL THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'retry_after_seconds', 0
    );
  END IF;

  v_retry := GREATEST(
    1,
    CEIL(extract(epoch FROM (v_expires_at - v_now)))::integer
  );
  RETURN jsonb_build_object(
    'allowed', false,
    'retry_after_seconds', v_retry
  );
END;
$$;

-- 反馈与建议没有资产，创建时直接进入系统审核队列。
CREATE FUNCTION create_text_submission(p_submission jsonb)
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
    OR p_submission ->> 'kind' NOT IN ('feedback', 'suggestion') THEN
    RAISE EXCEPTION 'invalid text submission payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO submissions (
    id,
    kind,
    title,
    body,
    status,
    status_token_hash
  )
  VALUES (
    p_submission ->> 'id',
    p_submission ->> 'kind',
    p_submission ->> 'title',
    p_submission ->> 'body',
    'system_reviewing',
    p_submission ->> 'status_token_hash'
  )
  RETURNING * INTO v_submission;

  INSERT INTO public_engagement (submission_id)
  VALUES (v_submission.id);
  RETURN to_jsonb(v_submission);
END;
$$;

-- 点赞切换串行锁定汇总行，投票去重和计数更新位于同一事务。
CREATE FUNCTION toggle_public_like(
  p_submission_id text,
  p_fingerprint_hash char(64)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
  v_like_count bigint;
  v_status text;
  v_kind text;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_fingerprint_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid public like input' USING ERRCODE = '22023';
  END IF;

  SELECT status, kind INTO v_status, v_kind
  FROM submissions
  WHERE id = p_submission_id;
  IF v_status IS DISTINCT FROM 'published' OR v_kind <> 'shared_package' THEN
    RAISE EXCEPTION 'published submission not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public_engagement (submission_id)
  VALUES (p_submission_id)
  ON CONFLICT (submission_id) DO NOTHING;
  PERFORM 1 FROM public_engagement
  WHERE submission_id = p_submission_id
  FOR UPDATE;

  DELETE FROM engagement_votes
  WHERE submission_id = p_submission_id
    AND fingerprint_hash = p_fingerprint_hash;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 1 THEN
    UPDATE public_engagement
    SET like_count = GREATEST(0, like_count - 1),
        updated_at = now()
    WHERE submission_id = p_submission_id
    RETURNING like_count INTO v_like_count;
    RETURN jsonb_build_object('liked', false, 'like_count', v_like_count);
  END IF;

  INSERT INTO engagement_votes (submission_id, fingerprint_hash)
  VALUES (p_submission_id, p_fingerprint_hash);
  UPDATE public_engagement
  SET like_count = like_count + 1,
      updated_at = now()
  WHERE submission_id = p_submission_id
  RETURNING like_count INTO v_like_count;
  RETURN jsonb_build_object('liked', true, 'like_count', v_like_count);
END;
$$;

-- 下载计数只允许已发布共享包，计数成功后应用层才能签发私有地址。
CREATE FUNCTION record_public_download(p_submission_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_download_count bigint;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM submissions
    WHERE id = p_submission_id
      AND status = 'published'
      AND kind = 'shared_package'
  ) THEN
    RAISE EXCEPTION 'published submission not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public_engagement (submission_id, download_count)
  VALUES (p_submission_id, 1)
  ON CONFLICT (submission_id)
  DO UPDATE SET download_count = public_engagement.download_count + 1,
                updated_at = now()
  RETURNING download_count INTO v_download_count;
  RETURN jsonb_build_object('download_count', v_download_count);
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

ALTER TABLE captcha_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE captcha_replays FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE captcha_replays FROM anon, authenticated;
GRANT ALL ON TABLE captcha_replays TO service_role;

ALTER TABLE abuse_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_counters FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE abuse_counters FROM anon, authenticated;
GRANT ALL ON TABLE abuse_counters TO service_role;

ALTER TABLE engagement_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_votes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE engagement_votes FROM anon, authenticated;
GRANT ALL ON TABLE engagement_votes TO service_role;

REVOKE ALL ON SEQUENCE assets_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE assets_id_seq TO service_role;
REVOKE ALL ON SEQUENCE moderation_results_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE moderation_results_id_seq TO service_role;
REVOKE ALL ON SEQUENCE admin_audit_logs_id_seq FROM anon, authenticated;
GRANT ALL ON SEQUENCE admin_audit_logs_id_seq TO service_role;

REVOKE ALL ON FUNCTION create_submission(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_submission(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION complete_submission_upload(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_submission_upload(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION claim_moderation_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_moderation_jobs(integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION record_moderation_failure(text, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_moderation_failure(text, bigint, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) TO service_role;
REVOKE ALL ON FUNCTION claim_cleanup_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_cleanup_jobs(integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION mark_submission_purged(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_submission_purged(text, bigint) TO service_role;
REVOKE ALL ON FUNCTION consume_captcha_ticket(char, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_captcha_ticket(char, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION consume_abuse_limit(text, char, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_abuse_limit(text, char, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION create_text_submission(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_text_submission(jsonb) TO service_role;
REVOKE ALL ON FUNCTION toggle_public_like(text, char) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION toggle_public_like(text, char) TO service_role;
REVOKE ALL ON FUNCTION record_public_download(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_public_download(text) TO service_role;

COMMIT;
