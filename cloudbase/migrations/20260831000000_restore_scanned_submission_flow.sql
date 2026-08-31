BEGIN;

-- 技术证据只在逐字段绑定当前投稿、不可覆盖对象、完整归档身份和最终状态版本时有效。
CREATE OR REPLACE FUNCTION technical_scan_evidence_valid(
  p_submission_id text,
  p_status_version bigint,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM moderation_results AS result
    JOIN assets AS asset
      ON asset.submission_id = result.submission_id
     AND asset.role = 'package'
    WHERE result.submission_id = p_submission_id
      AND result.kind = 'package_scan'
      AND result.provider = 'isolated-scanner'
      AND result.suggestion = 'Pass'
      AND result.completed_at IS NOT NULL
      AND result.rule_version = 'character-package-2026-08-15'
      AND jsonb_typeof(result.evidence -> 'packageSizeBytes') = 'number'
      AND jsonb_typeof(result.evidence -> 'archiveSizeBytes') = 'number'
      AND jsonb_typeof(result.evidence -> 'submissionStatusVersion') = 'number'
      AND result.evidence ->> 'submissionId' = p_submission_id
      AND result.evidence ->> 'packageStorageKey' = asset.object_key
      AND (result.evidence ->> 'packageSizeBytes')::bigint = asset.actual_size
      AND (result.evidence ->> 'archiveSizeBytes')::bigint = asset.actual_size
      AND result.evidence ->> 'archiveSha256' = asset.sha256
      AND result.evidence ->> 'archiveSha256' ~ '^[a-f0-9]{64}$'
      AND result.evidence ->> 'protocolVersion' = '2026-08-15'
      AND result.evidence ->> 'ruleVersion' = result.rule_version
      AND result.evidence ->> 'scanCode' = 'CHARACTER_PACKAGE_SCAN_PASSED'
      AND (result.evidence ->> 'completedAt')::timestamptz = result.completed_at
      AND (result.evidence ->> 'expiresAt')::timestamptz
        = result.completed_at + interval '24 hours'
      AND (result.evidence ->> 'expiresAt')::timestamptz > p_now
      AND (result.evidence ->> 'submissionStatusVersion')::bigint
        = p_status_version
  );
$$;

-- 上传完成后只进入私有系统审核队列，人工队列必须由成功扫描决策推进。
CREATE OR REPLACE FUNCTION complete_submission_upload(
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
      sha256 = NULL,
      mime_type = provided.content_type,
      signature_valid = true,
      scan_status = 'pending',
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
      moderation_lease_until = NULL,
      moderation_next_retry_at = NULL,
      moderation_last_error = NULL,
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

-- 无资产文本投稿同样先进入系统审核，不允许创建时直接进入人工队列。
CREATE OR REPLACE FUNCTION create_text_submission(p_submission jsonb)
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
    id, kind, title, body, status, status_token_hash
  ) VALUES (
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

-- 成功扫描写入完整归档身份；进入人工队列前由数据库再次验证 24 小时证据门。
CREATE OR REPLACE FUNCTION apply_moderation_decision(
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
    RAISE EXCEPTION 'invalid moderation decision' USING ERRCODE = '22023';
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
    submission_id, kind, provider, rule_version, suggestion, label, score,
    evidence, requested_at, completed_at, error_message
  )
  SELECT
    p_submission_id, result.kind, result.provider, result.rule_version,
    result.suggestion, result.label, result.score, result.evidence,
    result.requested_at, result.completed_at, result.error_message
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

  UPDATE assets AS asset
  SET sha256 = result.evidence ->> 'archiveSha256',
      scan_status = 'safe',
      updated_at = now()
  FROM moderation_results AS result
  WHERE result.submission_id = p_submission_id
    AND result.kind = 'package_scan'
    AND result.provider = 'isolated-scanner'
    AND result.suggestion = 'Pass'
    AND asset.submission_id = p_submission_id
    AND asset.role = 'package'
    AND result.evidence ->> 'packageStorageKey' = asset.object_key
    AND jsonb_typeof(result.evidence -> 'packageSizeBytes') = 'number'
    AND jsonb_typeof(result.evidence -> 'archiveSizeBytes') = 'number'
    AND jsonb_typeof(result.evidence -> 'submissionStatusVersion') = 'number'
    AND result.evidence ->> 'submissionId' = p_submission_id
    AND (result.evidence ->> 'submissionStatusVersion')::bigint
      = p_expected_version + 1
    AND result.evidence ->> 'protocolVersion' = '2026-08-15'
    AND result.evidence ->> 'ruleVersion' = result.rule_version
    AND result.evidence ->> 'scanCode' = 'CHARACTER_PACKAGE_SCAN_PASSED'
    AND (result.evidence ->> 'packageSizeBytes')::bigint = asset.actual_size
    AND (result.evidence ->> 'archiveSizeBytes')::bigint = asset.actual_size
    AND result.evidence ->> 'archiveSha256' ~ '^[a-f0-9]{64}$';

  IF v_submission.kind = 'shared_package'
    AND p_next_status = 'manual_review_pending'
    AND NOT technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version + 1,
      now()
    ) THEN
    RAISE EXCEPTION 'technical scan required' USING ERRCODE = 'P1003';
  END IF;

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

-- 管理动作改变版本后不得复用旧证据：共享包转人工或恢复统一回系统队列重扫。
CREATE OR REPLACE FUNCTION apply_admin_action(
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
  v_submission_kind text;
  v_pre_quarantine_status text;
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
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  SELECT status, kind, pre_quarantine_status, cleanup_started_at
  INTO v_previous_status, v_submission_kind, v_pre_quarantine_status,
    v_cleanup_started_at
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cleanup_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'submission cleanup already started' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_existing
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
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'published')
    OR (p_action = 'reject'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'admin_rejected')
    OR (p_action = 'move_to_manual'
      AND v_previous_status = 'auto_rejected'
      AND p_next_status = CASE
        WHEN v_submission_kind = 'shared_package'
          THEN 'system_reviewing'
        ELSE 'manual_review_pending'
      END)
    OR (p_action = 'delete'
      AND v_previous_status NOT IN ('purged', 'deleted_quarantined')
      AND p_next_status = 'deleted_quarantined')
    OR (p_action = 'restore'
      AND v_previous_status = 'deleted_quarantined'
      AND p_next_status = CASE
        WHEN v_submission_kind = 'shared_package'
          THEN 'system_reviewing'
        ELSE v_pre_quarantine_status
      END)
  ) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  IF p_action = 'approve'
    AND v_submission_kind = 'shared_package'
    AND NOT technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version,
      now()
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
        WHEN p_action IN ('approve', 'move_to_manual', 'restore') THEN NULL
        ELSE public_reason
      END,
      auto_rejection_reason = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE auto_rejection_reason
      END,
      risk_summary = CASE
        WHEN p_next_status = 'system_reviewing' THEN '{}'::jsonb
        ELSE risk_summary
      END,
      rejected_at = CASE
        WHEN p_action = 'reject' THEN now()
        WHEN p_action IN ('approve', 'move_to_manual', 'restore') THEN NULL
        ELSE rejected_at
      END,
      quarantined_at = CASE
        WHEN p_action = 'delete' THEN now()
        WHEN p_action = 'restore' THEN NULL
        ELSE quarantined_at
      END,
      purge_after = CASE
        WHEN p_action IN ('reject', 'delete') THEN now() + interval '3 days'
        WHEN p_action IN ('approve', 'move_to_manual', 'restore') THEN NULL
        ELSE purge_after
      END,
      pre_quarantine_status = CASE
        WHEN p_action = 'delete' THEN v_previous_status
        WHEN p_action = 'restore' THEN NULL
        ELSE pre_quarantine_status
      END,
      moderation_lease_until = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_lease_until
      END,
      moderation_attempts = CASE
        WHEN p_next_status = 'system_reviewing' THEN 0
        ELSE moderation_attempts
      END,
      moderation_next_retry_at = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_next_retry_at
      END,
      moderation_last_error = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_last_error
      END,
      moderation_alerted_at = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_alerted_at
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
    submission_id, admin_id, action, before_status, after_status, reason,
    idempotency_key, request_payload, result_snapshot
  )
  VALUES (
    p_submission_id, p_admin_id, p_action, v_previous_status, p_next_status,
    p_reason, p_idempotency_key, v_request_payload, v_result
  );
  RETURN v_result;
END;
$$;

-- 历史直接进入人工队列的投稿统一回系统队列，重新通过当前自动审核路径。
UPDATE submissions
SET status = 'system_reviewing',
    status_version = status_version + 1,
    moderation_lease_until = NULL,
    moderation_attempts = 0,
    moderation_next_retry_at = NULL,
    moderation_last_error = NULL,
    moderation_alerted_at = NULL,
    updated_at = now()
WHERE status = 'manual_review_pending';

REVOKE ALL ON FUNCTION technical_scan_evidence_valid(text, bigint, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION complete_submission_upload(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_submission_upload(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION create_text_submission(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_text_submission(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text)
  TO service_role;

COMMIT;
