BEGIN;

-- 上传完成仍保留对象事实校验，但最终状态不再维护已退役 worker 的租约字段。
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

-- 管理员状态机、风险覆盖与审计快照继续保留，只删除 worker 运行态的复位写入。
CREATE OR REPLACE FUNCTION apply_admin_action(
  p_submission_id text,
  p_admin_id text,
  p_action text,
  p_next_status text,
  p_expected_version bigint,
  p_idempotency_key text,
  p_reason text,
  p_risk_acknowledgement text DEFAULT NULL
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
  v_request_identity jsonb;
  v_request_payload jsonb;
  v_latest_scan_summary jsonb;
  v_submission submissions%ROWTYPE;
  v_result jsonb;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  -- 风险确认是动作级安全门，必须在幂等回放之前严格校验。
  IF (p_action = 'force_publish'
      AND p_risk_acknowledgement IS DISTINCT FROM 'ADMIN_OVERRIDE_ACCEPTED')
    OR (p_action <> 'force_publish' AND p_risk_acknowledgement IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  v_request_identity := jsonb_build_object(
    'submissionId', p_submission_id,
    'adminId', p_admin_id,
    'action', p_action,
    'nextStatus', p_next_status,
    'expectedVersion', p_expected_version,
    'reason', p_reason,
    'riskAcknowledgement', p_risk_acknowledgement
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  -- 幂等事实先于当前投稿生命周期，cleanup 与 purge 不得破坏首次回放。
  SELECT * INTO v_existing
  FROM admin_audit_logs
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_existing.request_payload - 'latestScanSummary' - 'riskAcknowledgement')
        <> (v_request_identity - 'riskAcknowledgement')
      OR COALESCE(
        v_existing.request_payload -> 'riskAcknowledgement',
        'null'::jsonb
      ) IS DISTINCT FROM (
        jsonb_build_object('riskAcknowledgement', p_risk_acknowledgement)
          -> 'riskAcknowledgement'
      ) THEN
      RAISE EXCEPTION 'idempotency key reused with different input'
        USING ERRCODE = 'P1001';
    END IF;
    RETURN v_existing.result_snapshot || jsonb_build_object('replayed', true);
  END IF;

  SELECT status, kind, pre_quarantine_status, cleanup_started_at
  INTO v_previous_status, v_submission_kind, v_pre_quarantine_status,
    v_cleanup_started_at
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cleanup_started_at IS NOT NULL AND v_previous_status <> 'purged' THEN
    RAISE EXCEPTION 'submission cleanup already started' USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (p_action = 'approve'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'published')
    OR (p_action = 'force_publish'
      AND v_submission_kind = 'shared_package'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'published')
    OR (p_action = 'reject'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'admin_rejected')
    OR (p_action = 'move_to_manual'
      AND v_previous_status IN ('system_reviewing', 'auto_rejected')
      AND p_next_status = 'manual_review_pending')
    OR (p_action = 'delete'
      AND v_previous_status NOT IN ('purged', 'deleted_quarantined')
      AND p_next_status = 'deleted_quarantined')
    OR (p_action = 'restore'
      AND v_previous_status = 'deleted_quarantined'
      AND p_next_status = CASE
        WHEN v_submission_kind = 'shared_package'
          THEN 'manual_review_pending'
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

  IF p_action = 'force_publish'
    AND technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version,
      now()
    ) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  SELECT jsonb_build_object(
    'kind', result.kind,
    'provider', result.provider,
    'ruleVersion', result.rule_version,
    'suggestion', result.suggestion,
    'label', result.label,
    'scanCode', result.evidence ->> 'scanCode',
    'completedAt', result.completed_at
  )
  INTO v_latest_scan_summary
  FROM moderation_results AS result
  WHERE result.submission_id = p_submission_id
    AND result.kind = 'package_scan'
  ORDER BY result.completed_at DESC NULLS LAST, result.id DESC
  LIMIT 1;

  v_request_payload := v_request_identity || jsonb_build_object(
    'latestScanSummary', v_latest_scan_summary
  );

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      publication_basis = CASE
        WHEN p_action = 'approve' THEN 'standard'
        WHEN p_action = 'force_publish' THEN 'admin_override'
        WHEN p_action = 'restore'
          AND v_submission_kind <> 'shared_package'
          AND v_pre_quarantine_status = 'published' THEN 'standard'
        WHEN p_next_status <> 'published' THEN NULL
        ELSE publication_basis
      END,
      published_at = CASE
        WHEN p_next_status = 'published' THEN COALESCE(published_at, now())
        ELSE published_at
      END,
      public_reason = CASE
        WHEN p_action = 'reject' THEN left(p_reason, 500)
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE public_reason
      END,
      rejected_at = CASE
        WHEN p_action = 'reject' THEN now()
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE rejected_at
      END,
      quarantined_at = CASE
        WHEN p_action = 'delete' THEN now()
        WHEN p_action = 'restore' THEN NULL
        ELSE quarantined_at
      END,
      purge_after = CASE
        WHEN p_action IN ('reject', 'delete') THEN now() + interval '3 days'
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE purge_after
      END,
      pre_quarantine_status = CASE
        WHEN p_action = 'delete' THEN v_previous_status
        WHEN p_action = 'restore' THEN NULL
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
    'submission', jsonb_build_object(
      'id', v_submission.id,
      'kind', v_submission.kind,
      'status', v_submission.status,
      'status_version', v_submission.status_version,
      'publication_basis', v_submission.publication_basis,
      'public_reason', v_submission.public_reason,
      'published_at', v_submission.published_at,
      'rejected_at', v_submission.rejected_at,
      'quarantined_at', v_submission.quarantined_at,
      'created_at', v_submission.created_at,
      'updated_at', v_submission.updated_at
    ),
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

-- 最终 schema 只移除 worker 运行结构；历史审核事实与发布安全结构继续保留。
DROP FUNCTION IF EXISTS claim_moderation_jobs(integer, timestamptz);
DROP FUNCTION IF EXISTS apply_moderation_decision(text, bigint, text, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS record_moderation_failure(text, bigint, text, jsonb);
DROP INDEX IF EXISTS submissions_moderation_queue_idx;
ALTER TABLE submissions
  DROP COLUMN moderation_lease_until,
  DROP COLUMN moderation_attempts,
  DROP COLUMN moderation_next_retry_at,
  DROP COLUMN moderation_last_error,
  DROP COLUMN moderation_alerted_at;

REVOKE ALL ON FUNCTION complete_submission_upload(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_submission_upload(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  TO service_role;

COMMIT;
