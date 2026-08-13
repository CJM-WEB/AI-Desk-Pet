BEGIN;

-- 共享包上传完成后直接进入人工审核，保留原有资产一致性校验。
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
  SET status = 'manual_review_pending',
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

-- 反馈与建议无需资产上传，创建时直接进入人工审核。
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
    'manual_review_pending',
    p_submission ->> 'status_token_hash'
  )
  RETURNING * INTO v_submission;

  INSERT INTO public_engagement (submission_id)
  VALUES (v_submission.id);
  RETURN to_jsonb(v_submission);
END;
$$;

-- 人工队列的新共享包可直接审批；历史自动驳回项仍要求技术扫描通过。
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
    AND v_previous_status = 'auto_rejected'
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

-- 已在系统队列中的投稿同步转入人工队列，并释放系统审核租约。
UPDATE submissions
SET status = 'manual_review_pending',
    status_version = status_version + 1,
    moderation_lease_until = NULL,
    moderation_next_retry_at = NULL,
    updated_at = now()
WHERE status = 'system_reviewing';

COMMIT;
